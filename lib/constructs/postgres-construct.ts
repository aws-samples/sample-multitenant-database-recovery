// lib/constructs/postgres-database.ts
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as path from 'path'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager'

export interface DatabaseProps {
  vpc: ec2.Vpc
  databaseSubnets: ec2.SubnetSelection
  selectedDatabase: string
}

export class PostgresDatabase extends Construct {
  // Common constants
  private readonly DB_PORT = 5432
  private readonly DB_ENGINE = 'postgres'
  private readonly DB_USERNAME = 'postgres'
  private readonly DB_PASSWORD = 'postgres'
  private readonly BACKUP_RETENTION_DAYS = 7
  private readonly STORAGE_TYPE = rds.StorageType.GP3

  // Security groups
  public dbSecurityGroup: ec2.SecurityGroup
  private initLambdaSg: ec2.SecurityGroup
  private simulateLambdaSg: ec2.SecurityGroup

  //Lambda functions
  public initLambda: nodejs.NodejsFunction
  public simulateActivityLambda: nodejs.NodejsFunction

  private secret: Secret

  // Database resources (only one of these will be set based on type)
  private dbInstance?: rds.DatabaseInstance
  private primaryInstance?: rds.DatabaseInstance
  private readReplica?: rds.DatabaseInstanceReadReplica
  private dbCluster?: rds.DatabaseCluster

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id)

    // Create security groups (common to all DB types)
    this.setupSecurityGroups(props)
    this.setupSecret(props)

    // Create the database based on type
    switch (props.selectedDatabase) {
      case 'SingleAz':
      case 'MultiAz':
        this.createInstance(props, props.selectedDatabase === 'MultiAz')
        break
      case 'AuroraProvisioned':
        this.createAuroraProvisioned(props)
        break
      case 'AuroraServerless':
        this.createAuroraServerless(props)
        break
      default:
        throw new Error(`Unknown database type: ${props.selectedDatabase}`)
    }

    // Setup Lambda functions
    this.setupInitLambda(props)
    this.setupSimulateActivityLambda(props)
  }

  private setupSecurityGroups(props: DatabaseProps): void {
    // Create security group for the database
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: props.vpc,
      description: `Security group for PostgreSQL database (${props.selectedDatabase})`,
      allowAllOutbound: true
    })

    // Create security groups for Lambda functions
    this.initLambdaSg = new ec2.SecurityGroup(this, 'InitLambdaSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for database initialization Lambda',
      allowAllOutbound: true
    })

    this.simulateLambdaSg = new ec2.SecurityGroup(this, 'SimulateLambdaSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for activity simulation Lambda',
      allowAllOutbound: true
    })

    // Allow Lambda security groups to access the database
    this.dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.initLambdaSg.securityGroupId),
      ec2.Port.tcp(this.DB_PORT),
      'Allow access from init Lambda'
    )

    this.dbSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(this.simulateLambdaSg.securityGroupId),
      ec2.Port.tcp(this.DB_PORT),
      'Allow access from simulation Lambda'
    )
  }

  private createInstance(props: DatabaseProps, multiAz: boolean): void {
    // Create PostgreSQL single-AZ RDS instance
    this.dbInstance = new rds.DatabaseInstance(this, 'RDSInstance', {
      instanceIdentifier: `${cdk.Stack.of(this).stackName.toLocaleLowerCase()}-postgres-${multiAz ? 'multi' : 'single'}-az`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_6
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      storageType: this.STORAGE_TYPE,
      allocatedStorage: 20,
      vpc: props.vpc,
      vpcSubnets: props.databaseSubnets,
      securityGroups: [this.dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(this.secret, this.DB_USERNAME),
      backupRetention: cdk.Duration.days(this.BACKUP_RETENTION_DAYS),
      storageEncrypted: true,
      multiAz,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      enablePerformanceInsights: true,
      performanceInsightRetention: cdk.aws_rds.PerformanceInsightRetention.DEFAULT,
      port: this.DB_PORT,
      iamAuthentication: true
    });
  }

  private createAuroraProvisioned(props: DatabaseProps): void {
    // Create engine for Aurora PostgreSQL
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_16_6
    })
    this.dbCluster = new rds.DatabaseCluster(this, 'AuroraProvisioned', {
      clusterIdentifier: `${cdk.Stack.of(this).stackName.toLocaleLowerCase()}-aurora-postgres-provisioned`,
      engine,
      credentials: rds.Credentials.fromSecret(this.secret, this.DB_USERNAME),
      writer: rds.ClusterInstance.provisioned('writer', {
        publiclyAccessible: false,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
      }),
      securityGroups: [this.dbSecurityGroup],
      vpc: props.vpc,
      vpcSubnets: props.databaseSubnets,
      port: this.DB_PORT,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      iamAuthentication: true,
      backup: {
        retention: cdk.Duration.days(this.BACKUP_RETENTION_DAYS)
      }
    });
  }

  private createAuroraServerless(props: DatabaseProps): void {
    // Create engine for Aurora PostgreSQL
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_16_6
    })

    // Create Serverless Aurora PostgreSQL cluster
    this.dbCluster = new rds.DatabaseCluster(this, 'AuroraServerless', {
      clusterIdentifier: `${cdk.Stack.of(this).stackName.toLocaleLowerCase()}-aurora-postgres-serverless`,
      engine,
      credentials: rds.Credentials.fromSecret(this.secret, this.DB_USERNAME),
      vpc: props.vpc,
      vpcSubnets: props.databaseSubnets,
      securityGroups: [this.dbSecurityGroup],
      serverlessV2MinCapacity: 0.5, // Using value from your original class
      serverlessV2MaxCapacity: 1, // Using value from your original class
      writer: rds.ClusterInstance.serverlessV2('writer'),
      port: this.DB_PORT,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      iamAuthentication: true,
      enableDataApi: true,
      backup: {
        retention: cdk.Duration.days(this.BACKUP_RETENTION_DAYS)
      }
    })
  }

  private setupInitLambda(props: DatabaseProps): void {
    this.initLambda = new nodejs.NodejsFunction(
      this,
      `InitDatabaseFunctionFor${props.selectedDatabase}`,
      {
        description: `Function that initializes the ${props.selectedDatabase} database`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(__dirname, '../lambda/init-database/index.ts'),
        handler: 'handler',
        timeout: cdk.Duration.minutes(5),
        vpc: props.vpc,
        securityGroups: [this.initLambdaSg],
        vpcSubnets: props.databaseSubnets,
        reservedConcurrentExecutions: 20,
        environment: {
          DB_SECRET_ARN: this.getDatabaseSecretArn(),
          DB_ENDPOINT: this.getDatabaseEndpoint(),
          DB_PORT: this.getDatabasePort().toString(),
          DB_ENGINE: this.DB_ENGINE
        },
        bundling: {
          commandHooks: {
            beforeBundling(): string[] {
              return []
            },
            beforeInstall(): string[] {
              return []
            },
            afterBundling(inputDir: string, outputDir: string): string[] {
              return [
                `cp ${inputDir}/lib/assets/global-bundle.pem ${outputDir}/global-bundle.pem`,
                `cp ${inputDir}/lib/lambda/init-database/schema.sql ${outputDir}/schema.sql`,

                // Debug to see what's actually happening
                `echo "Input dir: ${inputDir}"`,
                `echo "Output dir: ${outputDir}"`,
                `ls -la ${inputDir}/lib/assets/ || echo "Assets dir not found"`,
                `ls -la ${outputDir}`,
                
                // Ensure proper permissions
                `chmod 644 ${outputDir}/*.pem ${outputDir}/*.sql || true`,
              ]
            }
          },
          // Force docker bundling to ensure command hooks run
          forceDockerBundling: true
        }
      }
    );

    // Grant permissions to the init Lambda
    this.secret.grantRead(this.initLambda)

    // Create provider for custom resource
    const initProvider = new cdk.custom_resources.Provider(
      this,
      `InitDatabaseProviderFor${props.selectedDatabase}`,
      {
        onEventHandler: this.initLambda,
        logRetention: cdk.aws_logs.RetentionDays.ONE_DAY
      }
    )

    // Create custom resource to initialize the database
    const dbInitializer = new cdk.CustomResource(
      this,
      `DatabaseInitializerFor${props.selectedDatabase}`,
      {
        serviceToken: initProvider.serviceToken,
        properties: {
          DbResourceId: `${props.selectedDatabase}-${this.getDatabaseIdentifier()}`
        }
      }
    )

    // Ensure the initializer depends on the database
    if (this.dbInstance) {
      dbInitializer.node.addDependency(this.dbInstance)
    } else if (this.primaryInstance) {
      dbInitializer.node.addDependency(this.primaryInstance)
    } else if (this.dbCluster) {
      dbInitializer.node.addDependency(this.dbCluster)
    }
  }

  private setupSimulateActivityLambda(props: DatabaseProps): void {
    // Create Lambda for simulating database activity
    this.simulateActivityLambda = new nodejs.NodejsFunction(
      this,
      `SimulateActivityFor${props.selectedDatabase}`,
      {
        description: `Function that simulates activity on ${props.selectedDatabase} database`,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        entry: path.join(__dirname, '../lambda/simulate-activity/index.ts'),
        handler: 'handler',
        timeout: cdk.Duration.minutes(3),
        memorySize: 256,
        reservedConcurrentExecutions: 20,
        vpc: props.vpc,
        securityGroups: [this.simulateLambdaSg],
        vpcSubnets: props.databaseSubnets,
        environment: {
          DB_SECRET_ARN: this.getDatabaseSecretArn(),
          DB_ENDPOINT: this.getDatabaseEndpoint(),
          DB_PORT: this.getDatabasePort().toString(),
          DB_ENGINE: this.DB_ENGINE
        },
        bundling: {
          commandHooks: {
            beforeBundling(): string[] {
              return []
            },
            beforeInstall(): string[] {
              return []
            },
            afterBundling(inputDir: string, outputDir: string): string[] {
              return [
                `cp ${inputDir}/lib/assets/global-bundle.pem ${outputDir}/global-bundle.pem`,

                // Debug to see what's actually happening
                `echo "Input dir: ${inputDir}"`,
                `echo "Output dir: ${outputDir}"`,
                `ls -la ${inputDir}/lib/assets/ || echo "Assets dir not found"`,
                `ls -la ${outputDir}`,
                
                // Ensure proper permissions
                `chmod 644 ${outputDir}/*.pem ${outputDir}/*.sql || true`,
              ]
            }
          },
          // Force docker bundling to ensure command hooks run
          forceDockerBundling: true
        }
      }
    )

    // Grant permissions to the simulation Lambda
    this.secret.grantRead(this.simulateActivityLambda)

    // Add RDS permissions
    this.simulateActivityLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:DescribeDBInstances', 'rds:DescribeDBClusters'],
        resources: [this.getDatabaseArn()]
      })
    )

    // Create EventBridge rule to trigger simulation Lambda
    const simulationRule = new events.Rule(
      this,
      `SimulationScheduleRuleFor${props.selectedDatabase}`,
      {
        schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
        description: 'Trigger database activity simulation every minute'
      }
    )

    // Add Lambda as target for the rule
    simulationRule.addTarget(new targets.LambdaFunction(this.simulateActivityLambda))
  }

  private setupSecret(props: DatabaseProps): void {
    this.secret = new secretsmanager.Secret(this, `DatabaseSecretFor${props.selectedDatabase}`, {
      description: `Database credentials for ${props.selectedDatabase}`,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          username: this.DB_USERNAME,
          password: this.DB_PASSWORD,
          engine: 'postgres',
          port: this.DB_PORT
          // host and dbInstanceIdentifier will be updated after RDS creation
        })
      ),
    }); 
  }

  public allowDmsAccess(dmsSecurityGroup: ec2.SecurityGroup): void {
    this.dbSecurityGroup.addIngressRule(
      dmsSecurityGroup,
      ec2.Port.tcp(this.getDatabasePort()),
      'Allow DMS replication instance to access database'
    )
  }

  // Helper methods for getting database information
  public getDatabaseEndpoint(): string {
    if (this.dbInstance) {
      return this.dbInstance.dbInstanceEndpointAddress
    } else if (this.primaryInstance) {
      return this.primaryInstance.dbInstanceEndpointAddress
    } else if (this.dbCluster) {
      return this.dbCluster.clusterEndpoint.hostname
    }
    throw new Error('No database resource created')
  }

  // IDatabase interface implementations
  getDatabaseArn(): string {
    if (this.dbInstance) {
      return this.dbInstance.instanceArn
    } else if (this.primaryInstance) {
      return this.primaryInstance.instanceArn
    } else if (this.dbCluster) {
      return this.dbCluster.clusterArn
    }
    throw new Error('No database resource created')
  }

  getDatabaseIdentifier(): string {
    if (this.dbInstance) {
      return this.dbInstance.instanceIdentifier
    } else if (this.primaryInstance) {
      return this.primaryInstance.instanceIdentifier
    } else if (this.dbCluster) {
      return this.dbCluster.clusterIdentifier
    }
    throw new Error('No database resource created')
  }

  public getDatabaseSecretArn(): string {
    return this.secret.secretArn
  }

  public getDBSecurityGroup() {
    return this.dbSecurityGroup
  }

  public getDatabasePort(): number {
    return this.DB_PORT
  }

  public getEngine(): string {
    return this.DB_ENGINE
  }

  public getPassword(): string {
    return this.DB_PASSWORD
  }
}
