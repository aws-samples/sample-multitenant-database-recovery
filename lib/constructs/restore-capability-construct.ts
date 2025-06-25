// lib/constructs/restore-capability-construct.ts
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as sfn from 'aws-cdk-lib/aws-stepfunctions'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets'
import * as path from 'path'

export interface RestoreCapabilityConstructProps {
  vpc: ec2.Vpc
  databaseIdentifier: string
  databaseArn: string
  databaseSecurityGroup: ec2.SecurityGroup
  databasePort: number
  secretArn: string
  restorationSubnets: ec2.SubnetSelection
}

/**
 * RestoreCapabilityConstruct
 *
 * Creates a complete database restoration system using AWS Step Functions to orchestrate
 * point-in-time recovery of multi-tenant PostgreSQL databases with schema-level granularity.
 *
 *  ARCHITECTURE OVERVIEW:
 *
 * ┌─────────────── Step Functions ──────────────────┐
 * │                                                 │
 * │  ┌─────────┐      ┌─────────┐      ┌─────────┐  │
 * │  │ Temp    │◄────►│   DMS   │◄────►│ Prod    │  │
 * │  │Database │      │Migration│      │Database │  │
 * │  │         │      │         │      │         │  │
 * │  └─────────┘      └─────────┘      └─────────┘  │
 * │                                                 │
 * └─────────────────────────────────────────────────┘
 *
 *
 * RESTORATION WORKFLOW:
 *
 * 1. Create temporary database from backup/snapshot
 * 2. Extract DDL schema using ECS task
 * 3. Apply pre-DMS DDL (tables, primary keys) using ECS task
 * 4. Setup DMS endpoints and replication
 * 5. Migrate data via DMS replication tasks
 * 6. Apply post-DMS DDL (constraints, indexes) using ECS task
 * 7. Cleanup temporary resources
 *
 * Class construction order:
 * ├── 1. Security Groups         → Network isolation and access control
 * ├── 2. Subnet Groups           → RDS and DMS networking foundation
 * ├── 3. DynamoDB Table          → Restoration operation tracking
 * ├── 4. S3 Bucket               → DDL script storage with lifecycle
 * ├── 5. DMS IAM Roles           → Database migration service permissions
 * ├── 6. ECS Task IAM Roles      → Container execution permissions
 * ├── 7. ECS Task Permissions    → Grant specific AWS service access
 * ├── 8. State Machine IAM Role  → Orchestration service permissions
 * ├── 9. ECS Infrastructure      → Cluster and containerized tasks
 * ├── 10. Lambda Functions       → Secret management utilities
 * └── 11. State Machine          → Step Functions workflow definition
 *
 */
export class RestoreCapabilityConstruct extends Construct {
  // Public exports
  public dmsSecurityGroup: ec2.SecurityGroup

  // Private constants
  private TEMP_RESOURCES_PREFIX = 'tmp-resource-'

  // Core infrastructure resources
  private vpc: ec2.Vpc
  private restorationSubnets: ec2.SubnetSelection
  private originalDatabaseProps: {
    identifier: string
    arn: string
    securityGroup: ec2.SecurityGroup
    port: number
    secretArn: string
  }

  // Security Groups
  private temporaryDatabaseSecurityGroup!: ec2.SecurityGroup
  private ddlExtractionSecurityGroup!: ec2.SecurityGroup
  private ddlApplySecurityGroup!: ec2.SecurityGroup

  // IAM Roles
  private dmsVpcRole!: iam.Role
  private dmsEndpointRole!: iam.Role
  private ddlExtractionTaskRole!: iam.Role
  private ddlExtractionExecutionRole!: iam.Role
  private ddlApplyTaskRole!: iam.Role
  private ddlApplyExecutionRole!: iam.Role
  private stateMachineRole!: iam.Role

  // Infrastructure resources
  private ecsCluster!: ecs.Cluster
  private ddlStorageBucket!: s3.Bucket
  private restoreHistoryTable!: cdk.aws_dynamodb.Table
  private dbSubnetGroup!: cdk.aws_rds.SubnetGroup
  private dmsSubnetGroup!: cdk.aws_dms.CfnReplicationSubnetGroup

  // ECS Task Definitions
  private ddlExtractionTaskDefinition!: ecs.FargateTaskDefinition
  private ddlApplyTaskDefinition!: ecs.FargateTaskDefinition

  // Lambda Functions
  public createSecretLambda!: nodejs.NodejsFunction

  // State Machine
  private stateMachine: sfn.StateMachine

  constructor(scope: Construct, id: string, props: RestoreCapabilityConstructProps) {
    super(scope, id)

    // Store props for easy access
    this.vpc = props.vpc
    this.restorationSubnets = props.restorationSubnets
    this.originalDatabaseProps = {
      identifier: props.databaseIdentifier,
      arn: props.databaseArn,
      securityGroup: props.databaseSecurityGroup,
      port: props.databasePort,
      secretArn: props.secretArn
    }

    // Build infrastructure in logical order
    this.createSecurityGroups()
    this.createSubnetGroupsForRdsAndDms()
    this.createDynamoDBTable()
    this.createDDLStorageBucket()
    this.createDMSRoles()
    this.createECSTaskRoles()
    this.configureECSTaskPermissions()
    this.createStateMachineRole()
    this.createECSInfrastructure()
    this.createLambdaFunctions()
    this.createStateMachine()
  }

  // ============================================================================
  // SECURITY GROUPS
  // ============================================================================

  private createSecurityGroups(): void {
    // Security group for temporary restored database instances
    this.temporaryDatabaseSecurityGroup = new ec2.SecurityGroup(this, 'TemporaryDatabaseSG', {
      vpc: this.vpc,
      description:
        'Security group for temporary restored database instances during restoration process',
      allowAllOutbound: true
    })

    // Security group for DMS replication instances
    this.dmsSecurityGroup = new ec2.SecurityGroup(this, 'DMSReplicationSG', {
      vpc: this.vpc,
      description: 'Security group for DMS replication instances',
      allowAllOutbound: true
    })

    // Security group for DDL extraction ECS tasks
    this.ddlExtractionSecurityGroup = new ec2.SecurityGroup(this, 'DDLExtractionTaskSG', {
      vpc: this.vpc,
      description: 'Security group for DDL extraction ECS tasks',
      allowAllOutbound: true
    })

    // Security group for DDL apply ECS tasks
    this.ddlApplySecurityGroup = new ec2.SecurityGroup(this, 'DDLApplyTaskSG', {
      vpc: this.vpc,
      description: 'Security group for DDL apply ECS tasks',
      allowAllOutbound: true
    })

    // Allow DMS to access temporary restored databases
    this.temporaryDatabaseSecurityGroup.addIngressRule(
      this.dmsSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow DMS replication instances to access temporary restored databases'
    )

    // Allow DDL extraction tasks to access temporary restored databases
    this.temporaryDatabaseSecurityGroup.addIngressRule(
      this.ddlExtractionSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow DDL extraction tasks to access temporary restored databases'
    )

    // Allow DDL apply tasks to access original production databases
    this.originalDatabaseProps.securityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.ddlApplySecurityGroup.securityGroupId),
      ec2.Port.tcp(this.originalDatabaseProps.port),
      'Allow DDL apply tasks to access production databases'
    )
  }

  private createSubnetGroupsForRdsAndDms(): void {
    // RDS subnet group for temporary restored database instances
    this.dbSubnetGroup = new cdk.aws_rds.SubnetGroup(this, 'TemporaryDatabaseSubnetGroup', {
      description: 'Subnet group for temporary restored RDS instances during restoration process',
      vpc: this.vpc,
      vpcSubnets: this.restorationSubnets
    })

    // DMS subnet group for replication instances
    this.dmsSubnetGroup = new cdk.aws_dms.CfnReplicationSubnetGroup(
      this,
      'DMSReplicationSubnetGroup',
      {
        replicationSubnetGroupDescription:
          'Subnet group for DMS replication instances during restoration process',
        subnetIds: this.restorationSubnets.subnets!.map((subnet: ec2.ISubnet) => subnet.subnetId)
      }
    )
  }

  private createDynamoDBTable(): void {
    // DynamoDB table for tracking restoration operations
    this.restoreHistoryTable = new cdk.aws_dynamodb.Table(this, 'RestoreHistoryTable', {
      partitionKey: { name: 'restoreId', type: cdk.aws_dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: cdk.aws_dynamodb.AttributeType.STRING },
      billingMode: cdk.aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })
  }

  private createDDLStorageBucket(): void {
    // S3 bucket for storing DDL scripts during restoration process
    this.ddlStorageBucket = new s3.Bucket(this, 'DDLStorageBucket', {
      bucketName: `database-ddl-storage-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      //Objects in this Bucket are automatically deleted by the step function, this policy is in case of step function failure to delete objects
      lifecycleRules: [
        {
          id: 'DDLCleanup',
          enabled: true,
          expiration: cdk.Duration.days(1)
        }
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    })
  }

  private createDMSRoles(): void {
    // DMS VPC management role (required for DMS to operate in VPC)
    this.dmsVpcRole = new iam.Role(this, 'DMSVpcManagementRole', {
      roleName: 'dms-vpc-role',
      assumedBy: new iam.ServicePrincipal('dms.amazonaws.com'),
      description: 'Allows DMS to manage VPC resources during database restoration',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonDMSVPCManagementRole')
      ]
    })

    // DMS CloudWatch logs role (required for DMS logging)
    new iam.Role(this, 'DMSCloudWatchLogsRole', {
      roleName: 'dms-cloudwatch-logs-role',
      assumedBy: new iam.ServicePrincipal('dms.amazonaws.com'),
      description: 'Allows DMS to send logs to CloudWatch during database restoration',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonDMSCloudWatchLogsRole')
      ]
    })

    // DMS endpoint role (for accessing database secrets)
    this.dmsEndpointRole = new iam.Role(this, 'DMSEndpointRole', {
      assumedBy: new iam.ServicePrincipal(`dms.${cdk.Stack.of(this).region}.amazonaws.com`),
      description: 'Allows DMS endpoints to access database secrets in Secrets Manager'
    })

    // Grant DMS access to database secrets
    this.dmsEndpointRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [
          this.originalDatabaseProps.secretArn,
          `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:${this.TEMP_RESOURCES_PREFIX}*`
        ]
      })
    )

    // Ensure DMS subnet group depends on VPC role
    this.dmsSubnetGroup.node.addDependency(this.dmsVpcRole)
  }

  private createECSTaskRoles(): void {
    // DDL Extraction task role
    this.ddlExtractionTaskRole = new iam.Role(this, 'DDLExtractionTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role for DDL extraction ECS tasks during database restoration'
    })

    // DDL Extraction execution role
    this.ddlExtractionExecutionRole = new iam.Role(this, 'DDLExtractionExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    })

    // DDL Apply task role
    this.ddlApplyTaskRole = new iam.Role(this, 'DDLApplyTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Role for DDL apply ECS tasks during database restoration'
    })

    // DDL Apply execution role
    this.ddlApplyExecutionRole = new iam.Role(this, 'DDLApplyExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    })
  }

  private configureECSTaskPermissions(): void {
    // Common permissions for both DDL extraction and apply tasks
    const stepFunctionsPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
      resources: ['*'] // Task tokens are dynamic
    })

    const secretsManagerPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [
        this.originalDatabaseProps.secretArn,
        `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:${this.TEMP_RESOURCES_PREFIX}*`
      ]
    })

    // DDL Extraction specific permissions
    this.ddlStorageBucket.grantWrite(this.ddlExtractionTaskRole)
    this.ddlExtractionTaskRole.addToPolicy(stepFunctionsPolicy)
    this.ddlExtractionTaskRole.addToPolicy(secretsManagerPolicy)

    // DDL Apply specific permissions
    this.ddlStorageBucket.grantRead(this.ddlApplyTaskRole)
    this.ddlApplyTaskRole.addToPolicy(stepFunctionsPolicy)
    this.ddlApplyTaskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        resources: [this.originalDatabaseProps.secretArn]
      })
    )
  }

  private createStateMachineRole(): void {
    this.stateMachineRole = new iam.Role(this, 'RestoreStateMachineRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'Role for database restore state machine orchestration'
    })

    // RDS snapshot and restore permissions
    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'rds:DescribeDBSnapshots',
          'rds:DescribeDBInstances',
          'rds:DescribeDBClusters',
          'rds:RestoreDBInstanceToPointInTime',
          'rds:RestoreDBInstanceFromDBSnapshot',
          'rds:RestoreDBClusterToPointInTime',
          'rds:RestoreDBClusterFromSnapshot',
          'rds:DescribeDBClusterEndpoints',
          'rds:CreateDBInstance',
          'rds:AddTagsToResource'
        ],
        resources: [
          this.originalDatabaseProps.arn,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:snapshot:rds:${this.originalDatabaseProps.identifier}*`,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:snapshot:*`,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:cluster-snapshot:*`,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:db:${this.TEMP_RESOURCES_PREFIX}*`,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:cluster:${this.TEMP_RESOURCES_PREFIX}*`,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:cluster:${this.originalDatabaseProps.identifier}`,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:subgrp:${this.dbSubnetGroup.subnetGroupName}`
        ]
      })
    )

    // RDS deletion permissions for cleanup
    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['rds:DeleteDBInstance', 'rds:DeleteDBCluster'],
        resources: [
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:db:${this.TEMP_RESOURCES_PREFIX}*`,
          `arn:aws:rds:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:cluster:${this.TEMP_RESOURCES_PREFIX}*`
        ]
      })
    )

    // DMS replication instance permissions
    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dms:CreateReplicationInstance',
          'dms:DeleteReplicationInstance',
          'dms:TestConnection',
          'dms:AddTagsToResource',
          'dms:DescribeReplicationInstances',
          'dms:AddTagsToResource'
        ],
        resources: [
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:rep:*`,
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:subgrp:*`
        ]
      })
    )

    // DMS endpoint permissions
    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dms:CreateEndpoint',
          'dms:DeleteEndpoint',
          'dms:TestConnection',
          'dms:DescribeEndpoints',
          'dms:AddTagsToResource'
        ],
        resources: [
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint:*`
        ]
      })
    )

    // DMS replication task permissions
    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dms:StartReplicationTask',
          'dms:StopReplicationTask',
          'dms:DeleteReplicationTask',
          'dms:DescribeReplicationTasks',
          'dms:AddTagsToResource'
        ],
        resources: [
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:task:*`,
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:rep:*`
        ]
      })
    )

    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dms:CreateReplicationTask'],
        resources: [
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:task:*`,
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:rep:*`,
          `arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint:*`
        ]
      })
    )

    // DMS wide describe permissions
    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dms:DescribeReplicationInstances',
          'dms:DescribeEndpoints',
          'dms:DescribeReplicationTasks'
        ],
        resources: [`arn:aws:dms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:*:*`]
      })
    )

    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:TagResource'],
        resources: [
          `arn:aws:ecs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:task-definition/*`,
          `arn:aws:ecs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:task/*`
        ]
      })
    )

    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:DescribeSecret', 'secretsmanager:DeleteSecret'],
        resources: [
          this.originalDatabaseProps.secretArn,
          `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:${this.TEMP_RESOURCES_PREFIX}*`
        ]
      })
    )

    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [`${this.ddlStorageBucket.bucketArn}/*`]
      })
    )

    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:PutItem',
          'dynamodb:GetItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem'
        ],
        resources: [
          this.restoreHistoryTable.tableArn,
          `${this.restoreHistoryTable.tableArn}/index/*`
        ]
      })
    )

    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
        resources: [
          `arn:${cdk.Stack.of(this).partition}:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:rule/StepFunctions*`
        ]
      })
    )

    this.stateMachineRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole', 'iam:GetRole'],
        resources: [
          this.dmsEndpointRole.roleArn,
          this.ddlExtractionTaskRole.roleArn,
          this.ddlExtractionExecutionRole.roleArn,
          this.ddlApplyTaskRole.roleArn,
          this.ddlApplyExecutionRole.roleArn
        ]
      })
    )
  }

  private createECSInfrastructure(): void {
    // ECS cluster for running containerized restoration tasks
    this.ecsCluster = new ecs.Cluster(this, 'DatabaseRestorationCluster', {
      vpc: this.vpc,
      clusterName: `${cdk.Stack.of(this).stackName}-database-restoration`,
      containerInsights: true
    })

    // Build DDL extraction Docker image
    const ddlExtractionImage = new ecrAssets.DockerImageAsset(this, 'DDLExtractionImage', {
      directory: path.join(__dirname, '../containers/ddl-extraction'),
      platform: ecrAssets.Platform.LINUX_AMD64,
      buildArgs: { BUILDKIT_INLINE_CACHE: '1' }
    })

    // Create task definition for DDL extraction
    this.ddlExtractionTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'DDLExtractionTaskDefinition',
      {
        family: `${cdk.Stack.of(this).stackName}-ddl-extraction`,
        cpu: 1024,
        memoryLimitMiB: 2048,
        taskRole: this.ddlExtractionTaskRole,
        executionRole: this.ddlExtractionExecutionRole
      }
    )

    // Add container to task definition
    this.ddlExtractionTaskDefinition.addContainer('ddl-extraction', {
      image: ecs.ContainerImage.fromDockerImageAsset(ddlExtractionImage),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ddl-extraction',
        logGroup: new logs.LogGroup(this, 'DDLExtractionLogGroup', {
          logGroupName: `/ecs/${cdk.Stack.of(this).stackName}-ddl-extraction`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      })
    })

    // Build DDL apply Docker image
    const ddlApplyImage = new ecrAssets.DockerImageAsset(this, 'DDLApplyImage', {
      directory: path.join(__dirname, '../containers/ddl-apply'),
      platform: ecrAssets.Platform.LINUX_AMD64,
      buildArgs: { BUILDKIT_INLINE_CACHE: '1' }
    })

    // Create task definition for DDL apply
    this.ddlApplyTaskDefinition = new ecs.FargateTaskDefinition(this, 'DDLApplyTaskDefinition', {
      family: `${cdk.Stack.of(this).stackName}-ddl-apply`,
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: this.ddlApplyTaskRole,
      executionRole: this.ddlApplyExecutionRole
    })

    // Add container to task definition
    this.ddlApplyTaskDefinition.addContainer('ddl-apply', {
      image: ecs.ContainerImage.fromDockerImageAsset(ddlApplyImage),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'ddl-apply',
        logGroup: new logs.LogGroup(this, 'DDLApplyLogGroup', {
          logGroupName: `/ecs/${cdk.Stack.of(this).stackName}-ddl-apply`,
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY
        })
      }),
      environment: {
        DDL_STORAGE_BUCKET: this.ddlStorageBucket.bucketName
      }
    })
  }

  private createLambdaFunctions(): void {
    // Lambda function for creating temporary database secrets
    this.createSecretLambda = new nodejs.NodejsFunction(this, 'CreateSecretLambda', {
      description:
        'Creates temporary secrets in AWS Secrets Manager for restored database instances',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '../lambda/create-secret/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 20,
      environment: {
        RDS_SECRET_ARN: this.originalDatabaseProps.secretArn
      }
    })

    // Allow reading original secret
    this.createSecretLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'secretsmanager:DescribeSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:ListSecretVersionIds'
        ],
        resources: [this.originalDatabaseProps.secretArn]
      })
    )

    // Allow creating/deleting temporary secrets
    this.createSecretLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:CreateSecret', 'secretsmanager:DeleteSecret'],
        resources: [
          `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:${this.TEMP_RESOURCES_PREFIX}*`
        ]
      })
    )

    this.createSecretLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds:DescribeDBSnapshots',
          'rds:DescribeDBClusterSnapshots'
        ],
        resources: ['*'] // RDS describe operations requires * resource
      })
    )

    // Grant state machine permission to invoke Lambda
    this.createSecretLambda.grantInvoke(this.stateMachineRole)
  }

  private createStateMachine(): void {
    // Create log group for state machine execution logs
    const stateMachineLogGroup = new logs.LogGroup(this, 'RestoreStateMachineLogGroup', {
      logGroupName: `/aws/vendedlogs/states/${cdk.Stack.of(this).stackName}-RestoreStateMachine`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    // Create the state machine with proper substitutions
    this.stateMachine = new sfn.StateMachine(this, 'RestoreStateMachine', {
      definitionBody: sfn.DefinitionBody.fromFile(
        path.join(__dirname, '../state-machines/restore-workflow.json')
      ),
      definitionSubstitutions: {
        // DynamoDB
        DynamoDBTableName: this.restoreHistoryTable.tableName,

        // Security Groups
        DbSecurityGroupId: this.temporaryDatabaseSecurityGroup.securityGroupId,
        DmsSecurityGroupId: this.dmsSecurityGroup.securityGroupId,

        // Database Information
        OriginDBIdentifier: this.originalDatabaseProps.identifier,
        RDSSecretARN: this.originalDatabaseProps.secretArn,

        // DMS configuration
        DMSInstanceClass: 'dms.t3.medium',
        DMSEngineVersion: '3.5.4',

        // Networking
        DbSubnetGroupName: this.dbSubnetGroup.subnetGroupName,
        DmsSubnetGroupName: this.dmsSubnetGroup.ref,

        // IAM Roles
        DMSRoleArn: this.dmsEndpointRole.roleArn,

        // Lambda Functions
        LambdaCreateSecretArn: this.createSecretLambda.functionArn,

        // Storage
        DDLStorageBucket: this.ddlStorageBucket.bucketName,

        // ECS Infrastructure
        ECSClusterArn: this.ecsCluster.clusterArn,
        ECSTaskSubnet: this.restorationSubnets.subnets!.map((subnet) => subnet.subnetId).shift()!,

        // ECS Extract DDL
        DDLExtractTaskDefinitionArn: this.ddlExtractionTaskDefinition.taskDefinitionArn,
        DDLExtractTaskSecurityGroupId: this.ddlExtractionSecurityGroup.securityGroupId,
        DDLExtractTaskContainerName:
          this.ddlExtractionTaskDefinition.defaultContainer!.containerName,

        // ECS Apply DDL
        DDLApplyTaskDefinitionArn: this.ddlApplyTaskDefinition.taskDefinitionArn,
        DDLApplyTaskSecurityGroupId: this.ddlApplySecurityGroup.securityGroupId,
        DDLApplyTaskContainerName: this.ddlApplyTaskDefinition.defaultContainer!.containerName,

        ResourcesPrefix: this.TEMP_RESOURCES_PREFIX,

        // Tags to apply to all resources created during the restoration process. Useful for cost tracking for example
        Tags: JSON.stringify([
          {
            Key: 'Project',
            Value: 'DatabaseLevelRestoreStack'
          },
          {
            Key: 'Process',
            Value: 'Restoration'
          }
        ])
      },
      role: this.stateMachineRole,
      timeout: cdk.Duration.hours(6),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogGroup,
        level: sfn.LogLevel.ALL
      }
    })

    this.stateMachine.node.addDependency(this.ddlApplyTaskDefinition)
    this.stateMachine.node.addDependency(this.ddlApplyTaskDefinition)
    this.stateMachine.node.addDependency(this.ddlExtractionSecurityGroup)
    this.stateMachine.node.addDependency(this.ddlExtractionTaskDefinition)
    this.stateMachine.node.addDependency(this.createSecretLambda)
  }
}
