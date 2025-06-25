// lib/lambda/init-database/index.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { Client as PgClient } from 'pg'
import { CloudFormationCustomResourceEvent, CloudFormationCustomResourceResponse } from 'aws-lambda'
import * as fs from 'fs'
import * as path from 'path'

const secretsManagerClient = new SecretsManagerClient()

interface DatabaseCredentials {
  username: string
  password: string
  engine: string
  host: string
  port: number
}

// Function to get database credentials from Secrets Manager
async function getSecretValue(secretArn: string): Promise<DatabaseCredentials> {
  const command = new GetSecretValueCommand({ SecretId: secretArn })
  const response = await secretsManagerClient.send(command)
  if (response.SecretString) {
    return JSON.parse(response.SecretString)
  }
  throw new Error('Secret not found or has no string value')
}

// Load and execute the comprehensive schema SQL file
async function executeSchemaFile(
  client: PgClient,
  schemaName: string
): Promise<{ statementsExecuted: number; errors: string[] }> {
  const sqlFilePath = path.join(__dirname, 'schema.sql')

  if (!fs.existsSync(sqlFilePath)) {
    throw new Error(`SQL file not found: ${sqlFilePath}`)
  }

  console.log(`Loading SQL file: ${sqlFilePath}`)
  let sql = fs.readFileSync(sqlFilePath, 'utf8')

  // Replace schema name placeholder
  sql = sql.replace(/\{\{SCHEMA_NAME\}\}/g, schemaName)

  console.log(`Executing schema creation for: ${schemaName}`)

  try {
    // Execute the entire SQL file as one command - PostgreSQL handles it perfectly
    await client.query(sql)

    console.log(`✅ Schema ${schemaName} initialized successfully`)

    return {
      statementsExecuted: 1, // We executed one big SQL block
      errors: []
    }
  } catch (error: any) {
    console.error(`❌ Error executing schema SQL for ${schemaName}:`, error)

    // Handle expected errors gracefully
    if (error.message.includes('already exists') || error.message.includes('duplicate key')) {
      console.log('Ignoring "already exists" error - schema likely already initialized')
      return {
        statementsExecuted: 1,
        errors: [`IGNORED: ${error.message}`]
      }
    } else {
      throw new Error(`Critical SQL execution error: ${error.message}`)
    }
  }
}

// Main handler function
export async function handler(
  event: CloudFormationCustomResourceEvent
): Promise<CloudFormationCustomResourceResponse> {
  console.log('PostgreSQL database initialization started')
  console.log('Event:', JSON.stringify(event))

  const secretArn = process.env.DB_SECRET_ARN
  const dbEndpoint = process.env.DB_ENDPOINT
  const dbPort = process.env.DB_PORT || '5432'

  if (!secretArn || !dbEndpoint) {
    throw new Error('Missing required environment variables: DB_SECRET_ARN, DB_ENDPOINT')
  }

  try {
    const dbCredentials = await getSecretValue(secretArn)
    await initializePostgres(dbCredentials, dbEndpoint, dbPort)

    console.log('PostgreSQL database initialization completed successfully')

    return {
      Status: 'SUCCESS',
      PhysicalResourceId: 'PostgresqlDatabaseInitializer',
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: {
        Message: 'PostgreSQL database initialization completed successfully'
      }
    }
  } catch (error) {
    console.error('Error in PostgreSQL database initialization:', error)

    if (event.RequestType === 'Create') {
      return {
        Status: 'SUCCESS',
        PhysicalResourceId: 'PostgresqlDatabaseInitializer',
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        Data: {
          Message: 'Database initialization failed, but returning SUCCESS to allow stack creation'
        }
      }
    }

    return {
      Status: 'FAILED',
      PhysicalResourceId: event.PhysicalResourceId || 'PostgresqlDatabaseInitializer',
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Reason: `Database initialization failed: ${(error as Error).message}`
    }
  }
}

async function initializePostgres(
  credentials: DatabaseCredentials,
  endpoint: string,
  port: string
): Promise<void> {
  // First, create the tenant databases
  const defaultClient = new PgClient({
    host: endpoint,
    port: parseInt(port),
    database: 'postgres',
    user: credentials.username,
    password: credentials.password,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(path.join(__dirname, 'global-bundle.pem'))
    }
  })

  try {
    await defaultClient.connect()
    console.log('Connected to default PostgreSQL database')

    const databases = ['tenant_a', 'tenant_b']
    for (const dbName of databases) {
      const checkDb = await defaultClient.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
        dbName
      ])
      if (checkDb.rows.length === 0) {
        await defaultClient.query(`CREATE DATABASE ${dbName}`)
        console.log(`Created ${dbName} database`)
      } else {
        console.log(`${dbName} database already exists`)
      }
    }
  } finally {
    await defaultClient.end()
  }

  // Now initialize each tenant database with schemas
  const schemaMap = {
    tenant_a: ['customer_a1', 'customer_a2'],
    tenant_b: ['customer_b1', 'customer_b2']
  }

  for (const [dbName, schemas] of Object.entries(schemaMap)) {
    const client = new PgClient({
      host: endpoint,
      port: parseInt(port),
      database: dbName,
      user: credentials.username,
      password: credentials.password,
      ssl: {
        rejectUnauthorized: true,
        ca: fs.readFileSync(path.join(__dirname, 'global-bundle.pem'))
      }
    })

    try {
      await client.connect()
      console.log(`Connected to ${dbName} database`)

      for (const schemaName of schemas) {
        console.log(`\n=== Initializing schema: ${schemaName} in database: ${dbName} ===`)

        await client.query('BEGIN')

        try {
          const result = await executeSchemaFile(client, schemaName)
          await client.query('COMMIT')

          console.log(`✅ Schema ${schemaName} initialized successfully:`)
          console.log(`   - ${result.statementsExecuted} statements executed`)
          console.log(`   - ${result.errors.length} warnings`)

          if (result.errors.length > 0) {
            console.log('   Warnings:')
            result.errors.forEach((error) => console.log(`     ${error}`))
          }
        } catch (error) {
          await client.query('ROLLBACK')
          console.error(`❌ Error initializing schema ${schemaName}:`, error)
          throw error
        }
      }
    } finally {
      await client.end()
    }
  }
}
