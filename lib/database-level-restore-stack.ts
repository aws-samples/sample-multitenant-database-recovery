// lib/database-level-restore-stack.ts
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { NagSuppressions } from 'cdk-nag'

import { VpcConstruct } from './constructs/vpc-construct'
import { RestoreCapabilityConstruct } from './constructs/restore-capability-construct'
import { PostgresDatabase } from './constructs/postgres-construct'

export interface DatabaseLevelRestoreStackProps extends cdk.StackProps {
  selectedDatabase: string;
  ipAddress: string;
}

export class DatabaseLevelRestoreStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc
  public readonly bastionSecurityGroup: ec2.SecurityGroup
  public readonly databases: Map<string, any> = new Map()

  constructor(scope: Construct, id: string, props: DatabaseLevelRestoreStackProps) {
    super(scope, id, props)

    // Create isolated VPC for multi-tenant database operations
    const vpcConstruct = new VpcConstruct(this, 'VpcResources', {
      cidr: '10.0.0.0/16'
    })

    // Deploy selected database type (Single-AZ, Multi-AZ, Aurora)
    const databaseConstruct = new PostgresDatabase(this, 'Database', {
      vpc: vpcConstruct.vpc,
      databaseSubnets: vpcConstruct.databaseSubnets,
      selectedDatabase: props.selectedDatabase
    })

    // Core restore capability using Step Functions + DMS + ECS tasks
    const restoreCapabilityConstruct = new RestoreCapabilityConstruct(this, 'DatabaseRestore', {
      vpc: vpcConstruct.vpc,
      restorationSubnets: vpcConstruct.restorationSubnets,
      databaseArn: databaseConstruct.getDatabaseArn(),
      databaseSecurityGroup: databaseConstruct.getDBSecurityGroup(),
      databasePort: databaseConstruct.getDatabasePort(),
      databaseIdentifier: databaseConstruct.getDatabaseIdentifier(),
      secretArn: databaseConstruct.getDatabaseSecretArn()
    })
    databaseConstruct.allowDmsAccess(restoreCapabilityConstruct.dmsSecurityGroup)

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: databaseConstruct.getDatabaseSecretArn(),
      description: 'Database Secret Arn',
    })

    NagSuppressions.addStackSuppressions(cdk.Stack.of(this), [
       {
        id: 'AwsSolutions-RDS3',
        reason: 'the customer chooses to deploy single or multi-AZ'
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Use Lambda default Policy.'
      },
      {
        id: 'AwsSolutions-RDS10',
        reason: 'Allow Aurora cluster deletion when stack is deleted for clean-up.'
      },
      {
        id: 'AwsSolutions-RDS11',
        reason: 'Deploy with PORT 5432'
      },
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Let the user rotate the secret manually when testing.'
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'All permissions respect least privilige. Some policy require wildcards in resource names.',
      },
      {
        id: 'AwsSolutions-ECS2',
        reason: "his is a development/demo environment. In production environments, environment variables should be stored in AWS Systems Manager Parameter Store or Secrets Manager for enhanced security and operational flexibility.",
      },
      {
        id: 'AwsSolutions-S1',
        reason: "Access logs are voluntarily disabled for s3",
      },
      {
        id: 'AwsSolutions-L1',
        reason: "All Lambdas use latest version."
      },
      {
        id: 'AwsSolutions-VPC7',
        reason: "VPC Flow Logs not needed"
      },
      {
        id: 'AwsSolutions-EC28',
        reason: "detailed monitoring for EC2 not needed here"
      },
      {
        id: 'AwsSolutions-EC29',
        reason: "No termination protection needed"
      }
    ]);
  }
}
