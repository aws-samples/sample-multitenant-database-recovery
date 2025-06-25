# Multi-Tenant PostgreSQL Database-Level Recovery on AWS

[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-yellow.svg)](https://github.com/aws/mit-0)
[![CDK Version](https://img.shields.io/badge/CDK-v2.181.1-blue.svg)](https://docs.aws.amazon.com/cdk/v2/)

⚠️ **Development/Testing Use Only**: This open source project is designed for development and testing environments. Production deployments may require additional security hardening, performance optimizations, and operational considerations.

## Overview

Multi-tenant applications commonly implement data isolation strategies to meet security, performance, and compliance requirements. Two prevalent approaches are instance-per-tenant isolation, where each tenant operates within a dedicated Amazon Relational Database Service (Amazon RDS) instance or an Amazon Aurora cluster, and schema-per-tenant isolation, where tenants share database infrastructure while maintaining logical separation through distinct PostgreSQL databases or schemas.

The schema-per-tenant approach provides operational efficiency and cost optimization while ensuring strict logical data separation. However, this architecture presents a significant operational constraint: Amazon RDS native backup and restore capabilities operate exclusively at the database instance level, not at the granular level of individual databases or schemas.

When tenant-specific data recovery becomes necessary, this limitation creates operational challenges. Organizations must choose between restoring entire database instances (affecting all tenants) or implementing complex manual extraction processes.

This solution provides automated database restoration capabilities for multi-tenant PostgreSQL databases running on AWS RDS and Aurora. It implements **schema-level recovery** using AWS managed services.

### Solution Approach

This solution transforms data recovery from a reactive, manual process into a proactive, automated capability that provides:

- **Schema-level granularity** for individual tenant restoration
- **Side-by-side recovery** without overwriting production data
- **Automated orchestration** via Step Functions workflow
- **Point-in-Time Recovery (PITR)** and **snapshot-based** restoration options
- **Zero-downtime** operations for unaffected tenants

## Architecture

### High-Level Components

![Architecture Diagram](./architectures/architecture.png)

### Core AWS Services

The solution is built around four main AWS components that collaborate to perform granular restoration:

**AWS Step Functions**: Acts as the central orchestrator, coordinating the entire restoration process through a state machine that manages the complete lifecycle: from creating a temporary restored database to final resource cleanup, including parameter validation and error handling.

**Amazon RDS**: There are two distinct Amazon RDS instances or Amazon Aurora clusters in this process:

- **Production Database**: Contains current data. This is the instance that contains the schemas we want to restore, and continues to serve other tenants in normal operation throughout the restoration process.
- **Temporary Database**: Created specifically during and for restoration. This temporary instance is generated either by Point-in-Time Recovery (PITR) or from a snapshot of the production instance, allowing recovery of data to the exact desired state in the past. The temporary instance, isolated in dedicated subnets, serves only as an extraction source for historical data, while the production database continues to function normally without interruption.

**AWS Database Migration Service (AWS DMS)**: Ensures selective data transfer by copying only specified schemas from the temporary database to the production environment. DMS applies transformation rules to rename destination schemas (adding suffixes), thus enabling side-by-side restoration. This side-by-side approach is essential because the production schema structure may have evolved since the backup (column additions, constraint modifications, new tables), making direct replacement impossible. Recreation with a new name allows safe comparison of historical data without risking impact to the current production structure.

**Amazon Elastic Container Service (Amazon ECS)**: Executes specialized tasks for DDL extraction (via pg_dump) and application of Data Definition Language definitions. These automated containers extract the complete schema structure from the temporary database (tables, constraints, indexes, sequences, triggers) and recreate this structure in the production database with new names. This step is essential because while AWS DMS supports basic schema migration (table creation and primary keys), it does not automatically recreate secondary indexes, foreign keys, complex constraints, or other advanced structural elements in the target database.

### Network Design

The solution deploys across three subnet types for security isolation:

- **Database Subnets**: Production database instances with encryption at rest
- **Restoration Subnets**: Temporary infrastructure for recovery operations
- **VPC Endpoints**: Private connectivity to AWS services (Secrets Manager, S3, CloudWatch)

## AWS Step Functions Workflow

<picture>
  <img alt="Step Functions Workflow" src="./architectures/stepfunctions.jpg" style="border: 1px solid #ddd; background-color: white; padding: 10px;" />
</picture>

The AWS Step Functions state machine orchestrates a workflow that coordinates Amazon RDS, AWS DMS, Amazon ECS, and Lambda functions to perform database and/or schema-level restoration operations.

The state machine manages the complete lifecycle from temporary database provisioning to data migration and resource cleanup, with error handling and conditional logic to support different database architectures (Amazon RDS instances or Amazon Aurora clusters) and restoration methods (Point-in-Time Recovery vs snapshots). The entire process operates via AWS APIs while maintaining operation tracking and logging.

### Restoration Workflow (7 Phases)

#### Phase 1: Initialization & Preparation

The state machine begins by validating input parameters and establishing global variables including unique resource identifiers. Then records the restoration request in an Amazon DynamoDB table for complete audit tracking, then determines the database architecture by querying RDS to detect if the production database is a standard RDS instance or Aurora cluster, as restoration APIs differ between Amazon RDS for PostgreSQL and Amazon Aurora PostgreSQL.
Additionally, to improve the overall execution time of the AWS Step Function, the solution starts by creating the AWS DMS replication instance and will check, in phase 4, its readiness.  
- 

#### Phase 2: Temporary Instance Creation

- This phase creates a temporary database instance or cluster in isolated subnets using either Point-in-Time Recovery or restoration from snapshot (an input parameter of the state machine determines which option to use)
- The temporary database is provisioned with appropriate security groups as it is only needed for data extraction by AWS DMS and DDL extraction by Amazon ECS. The workflow monitors the provisioning process via polling loops, waiting for the temporary database to reach "available" status before proceeding to the next phase

#### Phase 3: DDL Extraction & Preparation

Once the temporary database is ready, the step function:

- **Creates a temporary secret** via AWS Lambda for DMS connectivity to the restored database. AWS DMS uses AWS Secrets Manager for Amazon RDS and Amazon Aurora database authentication. The lambda first determines the target timestamp of the restoration (either the snapshot creation date or the specified PITR timestamp), then analyzes the original secret's version history to identify which version was active at that precise moment. This approach ensures that the credentials used correspond exactly to those that were valid at the time of the restored data, automatically handling password rotations that might have occurred between backup and restoration. A new temporary secret is then created with these historical credentials while updating the host parameter to point to the temporary database instance.
- **Extracts complete DDL definitions** including tables, constraints, indexes, sequences, views, stored procedures, triggers, etc., using a specialized Amazon ECS task that uses pg_dump. The extracted DDL is then split into two parts and stored on Amazon S3 in three formats:
  - **Pre-DMS DDL** (tables, primary keys, sequences) which is immediately applied to the production database to create essential structures with transformed schema names including a temporal suffix (for example, schema customer_a1 becomes customer_a1_20240128143000)
  - **Post-DMS DDL** (constraints, secondary indexes, foreign keys, triggers and everything else) which will be applied after data migration
  - **Complete DDL** preserved as reference for audit and troubleshooting

This separation is necessary because referential integrity constraints (like foreign keys) can cause DMS migration to fail, as it copies tables in an order that doesn't necessarily respect dependencies between them. While it's technically possible to determine and enforce a migration order that respects these dependencies, this solution has deliberately chosen to let DMS manage the table order to simplify implementation and maintain ease of maintenance. Data migration therefore occurs first without constraints, then all integrity rules are applied once data transfer is complete.

#### Phase 4: Migration Orchestration

- Provisions DMS infrastructure including a replication instance
- Creates separate DMS endpoints for source (temporary database) and target (production database) connections
- The workflow performs mandatory connection tests to validate that both endpoints can successfully communicate with their respective databases via AWS Secrets Manager secrets before proceeding to data migration
- Processes each schema in the input schema list concurrently, creating individual DMS replication tasks with table mapping rules that select only data from the specified schema
- Monitors each replication task through its complete lifecycle from creation to execution and completion

#### Phase 5: Post-DMS DDL Application

- Once data migration is complete, an Amazon ECS task applies the post-DMS DDL to add all structural elements omitted during migration (secondary indexes, foreign keys, constraints, triggers, views, stored procedures), thus finalizing the integrity and performance of the restored schemas.

#### Phase 6: Resource Cleanup

- Deletes all temporary resources in parallel including:
  - Temporary database instance or cluster
  - AWS DMS infrastructure: Tasks, endpoints and instance
  - Temporary secret in Amazon Secrets Manager
  - DDL files stored in the S3 bucket
- The cleanup process also runs in case of failure, preventing unnecessary costs
- The cleanup process also executes in case of failure at any step, preventing accumulation of temporary resources and unnecessary costs.

#### Phase 7: Validation & Logging

- The Step Function saves the final operation status in DynamoDB (success or failure) with execution details, then returns a completion status indicating the restoration result. This traceability enables complete audit of restoration operations and facilitates troubleshooting in case of problems.

## Step Functions Input Parameters

The Step Functions accepts JSON input that precisely defines the restoration scope and source. The format varies depending on the chosen recovery method:

### Point-in-Time Recovery (PITR)

```json
{
  "database": "<databaseName>",
  "schemas": ["<schema1>", "<schema2>", "..."],
  "restoreTime": "2024-01-28T14:30:00Z"
}
```

### Snapshot-based Recovery

```json
{
  "database": "<databaseName>",
  "schemas": ["<schema1>", "<schema2>", "..."],
  "snapshotId": "<snapshotId>"
}
```

### Required Parameters

| Parameter                     | Description                                                                                                 | Options                                | required |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| `database`                    | Name of the PostgreSQL database in the Amazon RDS instance or Aurora cluster containing the data to restore | Any existing database name             | true     |
| `schemas`                     | Array of schema names to include in the restoration                                                         | At least one schema to restore     | true     |
| `restoreTime` OR `snapshotId` | **Either** ISO timestamp for PITR **or** snapshot identifier                                                | Must be within backup retention window | true     |

## What the Solution Deploys

The solution creates a comprehensive multi-tenant PostgreSQL environment for testing and demonstrating schema-level restoration capabilities. This includes both AWS infrastructure and a realistic database structure that simulates a production SaaS application.

### AWS Infrastructure

**Network Infrastructure:**

- **Amazon VPC** with dedicated public and private subnets (2 public, 2 private for production database, 2 private for restoration process)
- **VPC Endpoints** for private access to AWS services (Secrets Manager, S3, CloudWatch, Step Functions, etc.)
- **Security Groups** with least-privilege access rules for database, ECS tasks, and Lambdas

**Database Resources:**

- **Amazon RDS PostgreSQL or Amazon Aurora** instance with your selected configuration
- **AWS Secrets Manager** with encrypted database credentials and automatic rotation support
- **Continuous data generation** via AWS Lambda creating new records every minute to simulate real application activity

**Core Orchestration Services:**

- **AWS Step Functions** with pre-configured restoration state machine
- **Amazon ECS cluster** and Fargate task definitions for DDL extraction and application
- **AWS DMS infrastructure** including security groups, subnet groups, and IAM service roles
- **Amazon S3 bucket** for temporary DDL script storage during restorations with lifecycle policies

**Management and Monitoring:**

- **DynamoDB table** for restoration operation history and audit tracking
- **CloudWatch logs** for all service components with appropriate retention policies

**Lambda Functions:**

- **Create Secret Lambda**: Creates temporary secrets with appropriate historical credentials for DMS connectivity
- **Init Database Lambda**: Initializes database structure during deployment (schemas, tables, sample data)
- **Simulate Activity Lambda**: Continuously generates new data to simulate real application activity

### Supported Database Types

The solution supports multiple PostgreSQL deployment options:

| Context Value         | Database Type            | Configuration                 |
| --------------------- | ------------------------ | ----------------------------- |
| `SingleAz`          | RDS PostgreSQL Single-AZ | db.t4g.micro, 20GB storage    |
| `MultiAz`           | RDS PostgreSQL Multi-AZ  | db.t4g.micro, 20GB storage    |
| `AuroraProvisioned` | Aurora PostgreSQL        | db.t4g.medium writer instance |
| `AuroraServerless`  | Aurora Serverless v2     | 0.5-1 ACU auto-scaling        |

### Multi-Tenant Database Structure

The deployed solution implements a **schema-per-tenant isolation** pattern with two levels of organization:

#### Database and Schema Organization

| Database   | Schemas                      | Purpose                              |
| ---------- | ---------------------------- | ------------------------------------ |
| `tenant_a` | `customer_a1`, `customer_a2` | Tenant A's customer environments     |
| `tenant_b` | `customer_b1`, `customer_b2` | Tenant B's customer environments     |
| `postgres` | `public`                     | System database (PostgreSQL default) |

#### Table Structure per Schema

Each customer schema contains identical table structures with sample data for testing restoration capabilities:

| Table           | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| **users**       | Sample user accounts with various data types (JSONB, enums, timestamps) |
| **products**    | Product records with arrays, JSONB attributes, and inventory data       |
| **orders**      | Order records demonstrating foreign key relationships                   |
| **order_items** | Order line items showing complex table relationships                    |

#### Advanced PostgreSQL Features

- **Sequences**: Custom sequences for user IDs and order numbers
- **Functions**: User code generation and timestamp update triggers
- **Indexes**: Performance optimization on frequently queried columns
- **Constraints**: Foreign keys, unique constraints, and check constraints
- **Row Level Security**: Tenant data isolation policies
- **Views**: Aggregated reporting views for user and product analytics

## Deploy the Solution

### Prerequisites

Before deploying the database-level restoration solution, ensure you have:

- **AWS Account** with right level of permissions
- **AWS CLI** v2.0+ configured
- **Node.js** (version 18 or later) and npm
- **AWS CDK** CLI (version 2 or later)
- **Docker** running locally for ECS container packaging

### Deployment Steps

**Clone the repository:**

```bash
git clone https://github.com/aws-samples/database-level-restore
cd database-level-restore
```

**Build the project:**

```bash
npm install
npm run build
```

**Deploy the project:**

if not already done, run cdk boostrap

```bash
cdk bootstrap
```

```bash
cdk deploy DatabaseLevelRestoreStack --context selectedDatabase=AuroraServerless
```

Using Aurora Serverless, you can use [Aurora query editor](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/query-editor.html) to execute queries from the AWS console to check the recovery execution.

### To Launch a Restoration

**1. Access AWS Console:**
Navigate to "Step Functions" in the AWS Console where the solution is deployed.

**2. Start Execution:**
Find and click on the deployed state machine, then click "Start execution".

**3. Provide Input:**
Supply input based on your desired strategy. For example, for the deployed solution:

For Point-in-Time Recovery:

```json
{
  "database": "tenant_a",
  "schemas": ["customer_a1", "customer_a2"],
  "restoreTime": "2024-01-28T14:30:00Z"
}
```

Replace "2024-01-28T14:30:00Z" with a valid PITR restoration date.

For snapshot-based recovery:

```json
{
  "database": "tenant_a",
  "schemas": ["customer_a1", "customer_a2"],
  "snapshotId": "rds:snapshot-xxxxx"
}
```

Replace "rds:snapshot-xxxxx" with a valid snapshot ID restoration date.

**4. Monitor Execution:**
Wait for the State Machine to complete.

**5. View Results:**
Once finished, the solution creates a new recovery schema named, for example, `customer_a1_1706443800000` (the suffix is a timestamp) in the production database, containing data migrated from the temporary restored database instance. AWS DMS copies all data from tables in the selected schemas from the temporary database to new recovery schemas in the production environment, enabling side-by-side comparison with original schemas without overwriting or affecting existing production data.

You can view the results throughs Aurora query editor from the AWS console.

## Solution Cost

This cost is estimated for the Paris region (eu-west-3).

### Deployed Infrastructure Cost

**Amazon RDS or Amazon Aurora:** Depending on the database type selected during deployment

| Database Type                       | Configuration                    | Monthly Cost | Hourly Cost |
| ----------------------------------- | -------------------------------- | ------------ | ----------- |
| **Amazon RDS PostgreSQL Single-AZ** | db.t4g.micro, 20 GB storage      | $15.80       | ~$0.022     |
| **Amazon RDS PostgreSQL Multi-AZ**  | db.t4g.micro, 20 GB storage      | $31.60       | ~$0.043     |
| **Amazon Aurora Provisioned**       | 1 writer instance: db.t4g.medium | $59.97       | ~$0.082     |
| **Amazon Aurora Serverless**        | Min: 0.5 ACU, Max: 1 ACU         | $51.10       | ~$0.070     |

**Amazon EC2 Instance:** Free Tier eligible

**Amazon VPC Endpoints:**

- 10 VPC endpoints × 2 ENIs per endpoint × $0.011 USD = $0.22 per hour

### Cost per Restoration

**AWS Step Functions:**

- AWS Step Functions standard workflow charges per state transition. On average, depending on wait time in polling loops for resources to reach "available" status, uses 800 state transitions
- **Cost per execution:** $0.025

**AWS DMS:**

- AWS DMS is charged only during restoration time
- The deployed instance is a dms.t3.medium with 20GB storage
- For this solution, a restoration process takes an average of 35 minutes with the data copy phase lasting an average of 20 minutes
- **Cost per execution:** $0.028
- _Calculation formula: [(1 instance × $0.082 USD hourly) + (20 GB × 0.12 monthly) / 730 hours] / 60 minutes) × 20 minutes_

**Amazon S3:** $0.00 per execution (covered by free tier)

**Amazon DynamoDB:** $0.00 per execution (covered by free tier)

**Cost per 1000 executions: ~$55**

## Cleanup

To avoid incurring charges, delete the solution using:

```bash
cdk destroy DatabaseLevelRestoreStack
```

## Possible Improvements

While the current solution provides complete database and schema-level restoration capabilities for PostgreSQL, several improvements could further enhance its functionality and operational value:

### Multi-Engine Database Support

The architecture can be extended to support additional database engines including MySQL, SQL Server, Oracle, and other RDS-compatible databases. This expansion would require engine-specific DDL extraction logic and DMS configuration templates, but the workflow orchestration and resource management patterns remain consistent across database platforms.

### Enhanced Notification System

Automated notifications via Amazon Simple Notification Service (Amazon SNS) integration could provide real-time updates on restoration operation progress and completion status.

### Table-Level Granularity

Extending restoration capabilities to the table level would provide even finer control over data recovery operations. This enhancement would modify DMS table mapping rules to target specific tables within schemas while maintaining referential integrity via dependency analysis. Database administrators could restore corrupted tables without affecting related data, reducing restoration time and minimizing the scope of post-restoration data validation required.

### DMS Serverless Integration

Implementing DMS Serverless would eliminate the need for capacity planning. The solution could dynamically provision DMS capacity based on current data volume and migration complexity, providing automatic scaling for large restoration operations while maintaining cost efficiency for smaller tasks. This approach would be particularly beneficial for organizations with unpredictable restoration patterns or variable tenant database sizes.

### Automated Data Validation

Post-restoration data integrity checks could automatically validate restoration accuracy. These automated checks would compare source and target data upon completion, generating detailed validation reports and flagging any discrepancies for review. Custom validation rules could be configured per tenant or schema to verify specific business data relationships and constraints.

### Intelligent Rollback System

Automatic rollback capabilities would provide safety mechanisms for failed or corrupted restoration operations. If data validation checks fail or critical errors occur during the restoration process, the system could automatically remove recovery schemas and alert administrators without manual intervention. This enhancement would include configurable rollback triggers, comprehensive cleanup procedures, and detailed logging to support troubleshooting and process improvement efforts.

## Support

### Issue Reporting

For bug reports and feature requests, please create detailed GitHub issues with:

- Clear problem description and expected behavior
- Complete error messages and stack traces
- Relevant CloudWatch logs and execution details
- AWS region and account information (sanitized)
- Steps to reproduce the issue


## Documentation

- [Amazon Relational Database Service (Amazon RDS)](https://aws.amazon.com/rds/features/)
- [Amazon Aurora](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_AuroraOverview.html)
- [AWS Database Migration Service (AWS DMS)](https://aws.amazon.com/dms/features/)
- [Amazon Elastic Container Service (Amazon ECS)](https://aws.amazon.com/ecs/features/)
- [AWS Step Functions](https://aws.amazon.com/step-functions/features/)
- [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/features/)


## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file for details.

---

**Built by the AWS Solutions Architecture Team**

