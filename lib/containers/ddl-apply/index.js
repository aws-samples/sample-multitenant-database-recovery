// Unified DDL Apply Container - Let PostgreSQL handle validation
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager')
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } = require('@aws-sdk/client-sfn')
const { Client: PgClient } = require('pg')
const fs = require('fs')
const path = require('path')

// Initialize AWS clients
const secretsManagerClient = new SecretsManagerClient()
const s3Client = new S3Client()
const sfnClient = new SFNClient()

// Configuration from environment variables
const config = {
  targetSecretArn: process.env.DB_SECRET_ARN,
  targetDatabase: process.env.DB_NAME,
  ddlStorageBucket: process.env.S3_BUCKET,
  ddlObjectKey: process.env.S3_OBJECT_KEY,
  taskToken: process.env.TASK_TOKEN
}

// Logging utilities
const log = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  success: (msg) => console.log(`[SUCCESS] ${new Date().toISOString()} - ${msg}`),
  warning: (msg) => console.log(`[WARNING] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`)
}

// Validate required environment variables
function validateEnvironment() {
  log.info('Validating environment variables...')

  const required = ['DB_SECRET_ARN', 'DB_NAME', 'S3_BUCKET', 'S3_OBJECT_KEY', 'TASK_TOKEN']

  const missing = required.filter((key) => !process.env[key])

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  log.success('Environment validation complete')
  log.info(`Target: ${config.targetDatabase}`)
  log.info(`DDL Object: ${config.ddlObjectKey}`)
}

// Get database credentials from Secrets Manager
async function getSecretValue(secretArn) {
  log.info('Retrieving database credentials from Secrets Manager...')

  const command = new GetSecretValueCommand({ SecretId: secretArn })
  const response = await secretsManagerClient.send(command)

  if (!response.SecretString) {
    throw new Error('Secret does not contain string value')
  }

  const credentials = JSON.parse(response.SecretString)
  log.success('Database credentials retrieved successfully')

  return credentials
}

// Download DDL script from S3
async function downloadDDLFromS3(bucket, key) {
  log.info(`Downloading DDL script from S3: s3://${bucket}/${key}`)

  const getObjectCommand = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  })

  const response = await s3Client.send(getObjectCommand)

  if (!response.Body) {
    throw new Error('Empty response body from S3')
  }

  const ddlScript = await streamToString(response.Body)
  log.success(`Downloaded DDL script: ${ddlScript.length} characters`)

  return ddlScript
}

// Helper function to convert stream to string
async function streamToString(stream) {
  const chunks = []
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('error', (err) => reject(err))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

// Apply DDL to database - Let PostgreSQL handle all validation
async function applyDDLToDatabase(credentials, database, ddlScript) {
  const { host, port, username, password } = credentials

  const client = new PgClient({
    host,
    port,
    database,
    user: username,
    password,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(path.join(__dirname, 'global-bundle.pem'))
    }
  })

  await client.connect()
  log.success(`Connected to target database: ${database}`)

  const result = {
    ddlExecuted: false,
    errors: [],
    warnings: []
  }

  try {
    log.info('Starting DDL application transaction...')
    await client.query('BEGIN')

    // Apply the DDL script - PostgreSQL will handle all validation
    log.info('Applying DDL script...')
    log.info(`Script length: ${ddlScript.length} characters`)

    await client.query(ddlScript)
    result.ddlExecuted = true
    log.success('DDL script executed successfully')

    // COMMIT TRANSACTION
    await client.query('COMMIT')
    log.success('DDL transaction committed successfully')
  } catch (error) {
    log.error('Error during DDL application - rolling back transaction')
    log.error(`PostgreSQL error: ${error.message}`)

    try {
      await client.query('ROLLBACK')
      log.info('DDL transaction rolled back successfully')
    } catch (rollbackError) {
      log.error('Failed to rollback DDL transaction:', rollbackError)
    }

    result.ddlExecuted = false
    result.errors.push(`TRANSACTION ROLLED BACK: ${error.message}`)

    throw error
  } finally {
    await client.end()
  }

  return result
}

// Send success result to Step Functions
async function sendTaskSuccess(result) {
  if (!config.taskToken) {
    log.warning('No task token provided, skipping Step Functions notification')
    return
  }

  log.info('Sending success result to Step Functions...')

  const taskOutput = {
    statusCode: 200,
    ddlExecuted: result.ddlExecuted,
    errors: result.errors,
    warnings: result.warnings,
    executionTime: Date.now(),
    message: 'DDL applied successfully'
  }

  const command = new SendTaskSuccessCommand({
    taskToken: config.taskToken,
    output: JSON.stringify(taskOutput)
  })

  await sfnClient.send(command)
  log.success('Success result sent to Step Functions')
}

// Send failure result to Step Functions
async function sendTaskFailure(error) {
  if (!config.taskToken) {
    log.error(`DDL application failed: ${error.message}`)
    return
  }

  log.error('Sending failure result to Step Functions...')

  const command = new SendTaskFailureCommand({
    taskToken: config.taskToken,
    error: 'DDLApplicationError',
    cause: error.message
  })

  await sfnClient.send(command)
  log.error('Failure result sent to Step Functions')
}

// Main execution function
async function main() {
  const startTime = Date.now()

  try {
    log.info('=== DDL Application Container Started ===')

    // Validate environment
    validateEnvironment()

    // Get database credentials
    const credentials = await getSecretValue(config.targetSecretArn)

    // Download DDL script
    const ddlScript = await downloadDDLFromS3(config.ddlStorageBucket, config.ddlObjectKey)

    // Apply DDL to database
    const result = await applyDDLToDatabase(credentials, config.targetDatabase, ddlScript)

    const executionTime = Date.now() - startTime
    log.success(`DDL Application completed successfully in ${executionTime}ms`)

    // Send success to Step Functions
    await sendTaskSuccess(result)

    process.exit(0)
  } catch (error) {
    const executionTime = Date.now() - startTime
    log.error(`DDL Application failed after ${executionTime}ms: ${error.message}`)

    // Send failure to Step Functions
    await sendTaskFailure(error)

    process.exit(1)
  }
}

// Handle process signals gracefully
process.on('SIGINT', () => {
  log.info('Received SIGINT, shutting down gracefully...')
  process.exit(1)
})

process.on('SIGTERM', () => {
  log.info('Received SIGTERM, shutting down gracefully...')
  process.exit(1)
})

// Start the application
main().catch((error) => {
  log.error('Unhandled error in main:', error)
  process.exit(1)
})
