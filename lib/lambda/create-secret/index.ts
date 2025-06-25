import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  ListSecretVersionIdsCommand
} from '@aws-sdk/client-secrets-manager'
import { RDSClient, DescribeDBSnapshotsCommand, DescribeDBClusterSnapshotsCommand } from '@aws-sdk/client-rds'

const secretsManagerClient = new SecretsManagerClient()
const rdsClient = new RDSClient()

interface LambdaEvent {
  dbInstanceIdentifier: string
  host: string
  secretName: string
  restoreTime?: string // ISO timestamp for PITR
  snapshotId?: string // Snapshot ID for snapshot restore
}

interface SecretValue {
  engine: string
  host: string
  dbClusterIdentifier?: string
  dbInstanceIdentifier?: string
  username: string
  password: string
  dbname?: string
}

interface SecretVersion {
  VersionId?: string
  CreatedDate?: Date
  VersionStages?: string[]
}

async function determineTargetTime(
  event: LambdaEvent
): Promise<{ targetTime: Date; source: string }> {
  // Priority: Check snapshot first, then PITR time
  if (event.restoreTime) {
    console.log(`Using PITR with restore time: ${event.restoreTime}`)
    const pitrTime = new Date(event.restoreTime)

    if (isNaN(pitrTime.getTime())) {
      throw new Error(
        `Invalid PITR time format: ${event.restoreTime}. Expected ISO format like "2025-06-15T14:30:00Z"`
      )
    }

    return {
      targetTime: pitrTime,
      source: `PITR time ${event.restoreTime}`
    }
  } else if (event.snapshotId) {
    console.log(`Using snapshot-based restore with snapshot: ${event.snapshotId}`)

    // Get snapshot timestamp directly here
    console.log(`Getting snapshot timestamp for: ${event.snapshotId}`)
    
    let snapshot;
    try {
      const command = new DescribeDBSnapshotsCommand({
        DBSnapshotIdentifier: event.snapshotId
      });
      const response = await rdsClient.send(command);
      snapshot = response.DBSnapshots?.[0]
    } catch { //
      const command = new DescribeDBClusterSnapshotsCommand({
        DBClusterSnapshotIdentifier: event.snapshotId
      }); 
      const response = await rdsClient.send(command);
      snapshot = response.DBClusterSnapshots?.[0]
    }
    

    if (!snapshot?.SnapshotCreateTime) {
      throw new Error(`Snapshot ${event.snapshotId} not found or missing creation time`)
    }

    console.log(`Snapshot created at: ${snapshot.SnapshotCreateTime.toISOString()}`)
    return {
      targetTime: snapshot.SnapshotCreateTime,
      source: `snapshot ${event.snapshotId}`
    }
  }

  throw new Error('Either snapshotId or restoreTime must be provided')
}

async function findSecretVersionAtTime(
  secretArn: string,
  targetTime: Date
): Promise<{ secret: SecretValue; versionId: string }> {
  console.log(`Finding secret version active at: ${targetTime.toISOString()}`)

  // Get all versions of the secret
  const listCommand = new ListSecretVersionIdsCommand({
    SecretId: secretArn,
    IncludeDeprecated: true // Include all versions, not just current/pending
  })
  const versionsResponse = await secretsManagerClient.send(listCommand)

  if (!versionsResponse.Versions || versionsResponse.Versions.length === 0) {
    throw new Error('No secret versions found')
  }

  // Sort versions by creation date (oldest first)
  const sortedVersions = versionsResponse.Versions.filter((v) => v.CreatedDate) // Only versions with creation dates
    .sort((a, b) => a.CreatedDate!.getTime() - b.CreatedDate!.getTime())

  console.log(`Found ${sortedVersions.length} versions to evaluate`)

  // Find the latest version that was created before or at the target time
  let selectedVersion: SecretVersion | undefined

  for (const version of sortedVersions) {
    if (version.CreatedDate && version.CreatedDate <= targetTime) {
      selectedVersion = version
      console.log(
        `[Success] Version ${version.VersionId} created at ${version.CreatedDate.toISOString()} - candidate`
      )
    } else {
      console.log(
        `[Error] Version ${version.VersionId} created at ${version.CreatedDate?.toISOString()} - too recent`
      )
      break // Since sorted, all subsequent versions will be too recent
    }
  }

  if (!selectedVersion || !selectedVersion.VersionId) {
    throw new Error(
      `No secret version found that was active at target time ${targetTime.toISOString()}`
    )
  }

  console.log(
    `Selected version: ${selectedVersion.VersionId} (created: ${selectedVersion.CreatedDate?.toISOString()})`
  )

  // Get the secret value from the selected version directly here
  console.log(`Retrieving secret version: ${selectedVersion.VersionId}`)
  const getSecretCommand = new GetSecretValueCommand({
    SecretId: secretArn,
    VersionId: selectedVersion.VersionId
  })

  const response = await secretsManagerClient.send(getSecretCommand)

  if (!response.SecretString) {
    throw new Error(`Secret version ${selectedVersion.VersionId} does not contain string value`)
  }

  const secretValue: SecretValue = JSON.parse(response.SecretString)

  return {
    secret: secretValue,
    versionId: selectedVersion.VersionId
  }
}

/**
 * Creates temporary database secrets with historical passwords
 * matching the restore point (snapshot time or PITR time)
 */
export const handler = async (event: LambdaEvent) => {
  console.log('Event:', JSON.stringify(event, null, 2))
  const { dbInstanceIdentifier, host, secretName } = event

  if (!dbInstanceIdentifier || !host || !secretName) {
    throw new Error('Missing required parameters: dbInstanceIdentifier, host, or secretName')
  }

  try {
    // Step 1: Determine the target time from either snapshot or PITR
    const { targetTime, source } = await determineTargetTime(event)

    // Step 2: Find the secret version that was active at that time and get its value
    const originalSecretArn = process.env.RDS_SECRET_ARN!
    const { secret: originalSecret, versionId: targetVersionId } = await findSecretVersionAtTime(
      originalSecretArn,
      targetTime
    )

    // Step 3: Create new secret with the historical password but updated connection info
    const newSecret: SecretValue = {
      ...originalSecret,
      host,
      dbInstanceIdentifier: dbInstanceIdentifier
    }

    console.log(`Creating new secret: ${secretName}`)
    const createSecretCommand = new CreateSecretCommand({
      Name: secretName,
      SecretString: JSON.stringify(newSecret),
      Description: `Credentials for restored database instance ${dbInstanceIdentifier} (from ${source})`
    })

    const createResponse = await secretsManagerClient.send(createSecretCommand)
    const secretArn = createResponse.ARN!

    console.log(`Created new secret with ARN: ${secretArn}`)
    console.log(`Used historical secret version: ${targetVersionId}`)
    console.log(`Password matches ${source} at: ${targetTime.toISOString()}`)

    return {
      statusCode: 200,
      secretArn: secretArn,
      secretName: secretName,
      targetTime: targetTime.toISOString(),
      secretVersionUsed: targetVersionId,
      source: source,
      dbInstanceIdentifier: dbInstanceIdentifier
    }
  } catch (error) {
    console.error('[Error] creating secret:', error)
    throw error
  }
}
