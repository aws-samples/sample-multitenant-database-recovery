// lib/constructs/vpc-construct.ts
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'

export interface VpcConstructProps {
  cidr: string
}

export class VpcConstruct extends Construct {
  public readonly vpc: ec2.Vpc
  public readonly restorationSubnets: ec2.SubnetSelection
  public readonly databaseSubnets: ec2.SubnetSelection

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id)

    // Create VPC with isolated subnets - no NAT gateway.
    this.vpc = new ec2.Vpc(this, 'MultiTenantVPC', {
      maxAzs: 2,
      natGateways: 0, // usage of VPC endpoints instead
      ipAddresses: ec2.IpAddresses.cidr(props.cidr),
      subnetConfiguration: [
        {
          name: 'database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED, // Isolated subnets for databases
          cidrMask: 24
        },
        {
          name: 'restore', // Dedicated subnets for restore operations
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24
        }
      ]
    })

    this.restorationSubnets = this.vpc.selectSubnets({ subnetGroupName: 'restore' })
    this.databaseSubnets = this.vpc.selectSubnets({ subnetGroupName: 'database' })

    // VPC endpoints for AWS services - enables private subnet access without NAT
    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })

    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })

    new ec2.GatewayVpcEndpoint(this, 'S3Endpoint', {
      vpc: this.vpc,
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }]
    })

    // Add SSM Endpoints to allow SSM Session Manager access to instances in private subnets
    new ec2.InterfaceVpcEndpoint(this, 'SsmEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })

    new ec2.InterfaceVpcEndpoint(this, 'SsmMessagesEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })

    new ec2.InterfaceVpcEndpoint(this, 'Ec2MessagesEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })

    new ec2.InterfaceVpcEndpoint(this, 'EcrApiEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })

    // ECR Docker endpoint - for pulling Docker images
    new ec2.InterfaceVpcEndpoint(this, 'EcrDockerEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })

    new ec2.InterfaceVpcEndpoint(this, 'StepFunctionsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.STEP_FUNCTIONS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      privateDnsEnabled: true
    })
  }
}
