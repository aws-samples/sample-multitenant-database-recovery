// lambda/simulate-activity.ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { Client as PgClient } from 'pg'
import * as mysql from 'mysql2/promise'
import * as fs from 'fs'
import * as path from 'path'

const secretsManagerClient = new SecretsManagerClient()

// Function to get database credentials from Secrets Manager
async function getSecretValue(secretArn: string): Promise<any> {
  const command = new GetSecretValueCommand({ SecretId: secretArn })
  const response = await secretsManagerClient.send(command)
  if (response.SecretString) {
    return JSON.parse(response.SecretString)
  }
  throw new Error('Secret not found or has no string value')
}

// Enhanced data generation functions
function generateUniqueSuffix(): string {
  return Date.now().toString().slice(-6) + Math.floor(Math.random() * 1000)
}

function getRandomUserStatus(): string {
  const statuses = ['active', 'inactive', 'pending']
  return statuses[Math.floor(Math.random() * statuses.length)]
}

function getRandomOrderStatus(): string {
  const statuses = ['pending', 'processing', 'completed', 'cancelled']
  return statuses[Math.floor(Math.random() * statuses.length)]
}

function generateRandomAge(): number | null {
  // 70% chance of having an age, 30% null
  if (Math.random() < 0.3) return null
  return Math.floor(Math.random() * (65 - 18 + 1)) + 18 // Age between 18-65
}

function generateRandomBalance(): string {
  return (Math.random() * 1000).toFixed(2) // Balance between 0-1000
}

function generateRandomMetadata(): object {
  const metadataOptions = [
    {},
    { preferences: { newsletter: true, theme: 'dark' } },
    { last_login: new Date().toISOString(), login_count: Math.floor(Math.random() * 100) },
    { tags: ['premium', 'verified'], loyalty_points: Math.floor(Math.random() * 5000) },
    { region: 'US', timezone: 'EST', language: 'en' },
    { subscription: { type: 'premium', expires: '2025-12-31' } }
  ]
  return metadataOptions[Math.floor(Math.random() * metadataOptions.length)]
}

function generateRandomPrice(): string {
  return (Math.random() * 100 + 10).toFixed(2) // Price between $10-$110
}

function generateRandomTotal(): string {
  return (Math.random() * 500 + 20).toFixed(2) // Total between $20-$520
}

function generateRandomStockQuantity(): number {
  return Math.floor(Math.random() * 500) // Stock between 0-500
}

function generateRandomTags(): string[] {
  const allTags = [
    'electronics',
    'gadgets',
    'premium',
    'bestseller',
    'new',
    'sale',
    'featured',
    'popular',
    'trending',
    'limited'
  ]
  const numTags = Math.floor(Math.random() * 4) + 1 // 1-4 tags
  const shuffled = allTags.sort(() => 0.5 - Math.random())
  return shuffled.slice(0, numTags)
}

function generateRandomAttributes(): object {
  const attributes = [
    { color: 'red', size: 'medium', weight: '0.5kg' },
    { weight: '1kg', dimensions: '10x10x5', material: 'aluminum' },
    { material: 'plastic', warranty: '1 year', certification: 'CE' },
    { brand: 'TechBrand', model: '2024', country: 'USA' },
    {
      category: 'electronics',
      rating: (Math.random() * 5).toFixed(1),
      reviews: Math.floor(Math.random() * 1000)
    },
    { eco_friendly: true, recyclable: true, energy_rating: 'A+' }
  ]
  return attributes[Math.floor(Math.random() * attributes.length)]
}

function generateRandomNotes(): string | null {
  if (Math.random() < 0.4) return null // 40% chance of no notes

  const notes = [
    'Express delivery requested',
    'Gift wrapping required',
    'Customer called for status update',
    'Special handling instructions provided',
    'Bulk order discount applied',
    'Customer loyalty reward used',
    'International shipping',
    'Rush order processing'
  ]
  return notes[Math.floor(Math.random() * notes.length)]
}

// Main handler function
export async function handler(event: any): Promise<any> {
  console.log('Event:', JSON.stringify(event))

  const secretArn = process.env.DB_SECRET_ARN
  const dbEndpoint = process.env.DB_ENDPOINT
  const dbPort = process.env.DB_PORT || '5432'
  const dbEngine = process.env.DB_ENGINE || 'postgres'

  if (!secretArn || !dbEndpoint) {
    throw new Error('Missing required environment variables: DB_SECRET_ARN, DB_ENDPOINT')
  }

  try {
    // Get database credentials
    const dbCredentials = await getSecretValue(secretArn)

    // Determine how many records to insert (random between 1-5 for each type)
    const numUsers = Math.floor(Math.random() * 5) + 1
    const numProducts = Math.floor(Math.random() * 5) + 1
    const numOrders = Math.floor(Math.random() * 5) + 1

    console.log(`Will insert ${numUsers} users, ${numProducts} products, and ${numOrders} orders`)

    // Run the simulation for the appropriate database engine
    if (dbEngine === 'mysql') {
      await simulateMySqlActivity(
        dbCredentials,
        dbEndpoint,
        dbPort,
        numUsers,
        numProducts,
        numOrders
      )
    } else {
      await simulatePostgresActivity(
        dbCredentials,
        dbEndpoint,
        dbPort,
        numUsers,
        numProducts,
        numOrders
      )
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Successfully simulated database activity',
        recordsInserted: {
          users: numUsers,
          products: numProducts,
          orders: numOrders
        }
      })
    }
  } catch (error) {
    console.error('Error in simulate activity handler:', error)
    throw error
  }
}

async function simulatePostgresActivity(
  credentials: any,
  endpoint: string,
  port: string,
  numUsers: number,
  numProducts: number,
  numOrders: number
): Promise<void> {
  // ---- TENANT A DATABASE ----
  const tenantAClient = new PgClient({
    host: endpoint,
    port: parseInt(port),
    database: 'tenant_a',
    user: credentials.username,
    password: credentials.password,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(path.join(__dirname, 'global-bundle.pem'))
    }
  })

  try {
    await tenantAClient.connect()
    console.log('Connected to tenant_a database')

    // ========== CUSTOMER A1 SCHEMA ==========
    console.log('Simulating activity for customer_a1 schema')

    // Insert random users with all columns
    for (let i = 0; i < numUsers; i++) {
      const suffix = generateUniqueSuffix()
      const age = generateRandomAge()
      const balance = generateRandomBalance()
      const metadata = generateRandomMetadata()
      const status = getRandomUserStatus()

      await tenantAClient.query(
        `
        INSERT INTO customer_a1.users (name, email, status, age, balance, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (email) DO NOTHING
      `,
        [
          `Customer A1 User ${suffix}`,
          `user${suffix}@customer-a1-demo.com`,
          status,
          age,
          balance,
          JSON.stringify(metadata)
        ]
      )
    }

    // Insert random products with all columns
    for (let i = 0; i < numProducts; i++) {
      const suffix = generateUniqueSuffix()
      const price = generateRandomPrice()
      const stockQuantity = generateRandomStockQuantity()
      const tags = generateRandomTags()
      const attributes = generateRandomAttributes()
      const isActive = Math.random() > 0.1 // 90% chance active

      await tenantAClient.query(
        `
        INSERT INTO customer_a1.products (name, description, price, stock_quantity, tags, attributes, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (name) DO NOTHING
      `,
        [
          `Product A1-${suffix}`,
          `Detailed description for product ${suffix} with comprehensive specifications and features`,
          price,
          stockQuantity,
          tags, // PostgreSQL handles array conversion automatically
          JSON.stringify(attributes),
          isActive
        ]
      )
    }

    // Get actual user IDs for orders
    const userIdsA1 = await tenantAClient.query(
      `
      SELECT id FROM customer_a1.users ORDER BY RANDOM() LIMIT $1
    `,
      [numOrders]
    )

    // Insert random orders with all columns
    for (const row of userIdsA1.rows) {
      const totalAmount = generateRandomTotal()
      const status = getRandomOrderStatus()
      const notes = generateRandomNotes()

      await tenantAClient.query(
        `
        INSERT INTO customer_a1.orders (user_id, total_amount, status, notes)
        VALUES ($1, $2, $3, $4)
      `,
        [row.id, totalAmount, status, notes]
      )
    }

    // ========== CUSTOMER A2 SCHEMA ==========
    console.log('Simulating activity for customer_a2 schema')

    // Insert random users
    for (let i = 0; i < numUsers; i++) {
      const suffix = generateUniqueSuffix()
      const age = generateRandomAge()
      const balance = generateRandomBalance()
      const metadata = generateRandomMetadata()
      const status = getRandomUserStatus()

      await tenantAClient.query(
        `
        INSERT INTO customer_a2.users (name, email, status, age, balance, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (email) DO NOTHING
      `,
        [
          `Customer A2 User ${suffix}`,
          `user${suffix}@customer-a2-demo.com`,
          status,
          age,
          balance,
          JSON.stringify(metadata)
        ]
      )
    }

    // Insert random products
    for (let i = 0; i < numProducts; i++) {
      const suffix = generateUniqueSuffix()
      const price = generateRandomPrice()
      const stockQuantity = generateRandomStockQuantity()
      const tags = generateRandomTags()
      const attributes = generateRandomAttributes()
      const isActive = Math.random() > 0.1

      await tenantAClient.query(
        `
        INSERT INTO customer_a2.products (name, description, price, stock_quantity, tags, attributes, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (name) DO NOTHING
      `,
        [
          `Product A2-${suffix}`,
          `Detailed description for product ${suffix} with comprehensive specifications and features`,
          price,
          stockQuantity,
          tags,
          JSON.stringify(attributes),
          isActive
        ]
      )
    }

    // Get actual user IDs for orders
    const userIdsA2 = await tenantAClient.query(
      `
      SELECT id FROM customer_a2.users ORDER BY RANDOM() LIMIT $1
    `,
      [numOrders]
    )

    // Insert random orders
    for (const row of userIdsA2.rows) {
      const totalAmount = generateRandomTotal()
      const status = getRandomOrderStatus()
      const notes = generateRandomNotes()

      await tenantAClient.query(
        `
        INSERT INTO customer_a2.orders (user_id, total_amount, status, notes)
        VALUES ($1, $2, $3, $4)
      `,
        [row.id, totalAmount, status, notes]
      )
    }
  } finally {
    await tenantAClient.end()
  }

  // ---- TENANT B DATABASE ----
  const tenantBClient = new PgClient({
    host: endpoint,
    port: parseInt(port),
    database: 'tenant_b',
    user: credentials.username,
    password: credentials.password,
    ssl: {
      rejectUnauthorized: true,
      ca: fs.readFileSync(path.join(__dirname, 'global-bundle.pem'))
    }
  })

  try {
    await tenantBClient.connect()
    console.log('Connected to tenant_b database')

    // ========== CUSTOMER B1 SCHEMA ==========
    console.log('Simulating activity for customer_b1 schema')

    // Insert random users
    for (let i = 0; i < numUsers; i++) {
      const suffix = generateUniqueSuffix()
      const age = generateRandomAge()
      const balance = generateRandomBalance()
      const metadata = generateRandomMetadata()
      const status = getRandomUserStatus()

      await tenantBClient.query(
        `
        INSERT INTO customer_b1.users (name, email, status, age, balance, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (email) DO NOTHING
      `,
        [
          `Customer B1 User ${suffix}`,
          `user${suffix}@customer-b1-demo.com`,
          status,
          age,
          balance,
          JSON.stringify(metadata)
        ]
      )
    }

    // Insert random products
    for (let i = 0; i < numProducts; i++) {
      const suffix = generateUniqueSuffix()
      const price = generateRandomPrice()
      const stockQuantity = generateRandomStockQuantity()
      const tags = generateRandomTags()
      const attributes = generateRandomAttributes()
      const isActive = Math.random() > 0.1

      await tenantBClient.query(
        `
        INSERT INTO customer_b1.products (name, description, price, stock_quantity, tags, attributes, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (name) DO NOTHING
      `,
        [
          `Product B1-${suffix}`,
          `Detailed description for product ${suffix} with comprehensive specifications and features`,
          price,
          stockQuantity,
          tags,
          JSON.stringify(attributes),
          isActive
        ]
      )
    }

    // Get actual user IDs for orders
    const userIdsB1 = await tenantBClient.query(
      `
      SELECT id FROM customer_b1.users ORDER BY RANDOM() LIMIT $1
    `,
      [numOrders]
    )

    // Insert random orders
    for (const row of userIdsB1.rows) {
      const totalAmount = generateRandomTotal()
      const status = getRandomOrderStatus()
      const notes = generateRandomNotes()

      await tenantBClient.query(
        `
        INSERT INTO customer_b1.orders (user_id, total_amount, status, notes)
        VALUES ($1, $2, $3, $4)
      `,
        [row.id, totalAmount, status, notes]
      )
    }

    // ========== CUSTOMER B2 SCHEMA ==========
    console.log('Simulating activity for customer_b2 schema')

    // Insert random users
    for (let i = 0; i < numUsers; i++) {
      const suffix = generateUniqueSuffix()
      const age = generateRandomAge()
      const balance = generateRandomBalance()
      const metadata = generateRandomMetadata()
      const status = getRandomUserStatus()

      await tenantBClient.query(
        `
        INSERT INTO customer_b2.users (name, email, status, age, balance, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (email) DO NOTHING
      `,
        [
          `Customer B2 User ${suffix}`,
          `user${suffix}@customer-b2-demo.com`,
          status,
          age,
          balance,
          JSON.stringify(metadata)
        ]
      )
    }

    // Insert random products
    for (let i = 0; i < numProducts; i++) {
      const suffix = generateUniqueSuffix()
      const price = generateRandomPrice()
      const stockQuantity = generateRandomStockQuantity()
      const tags = generateRandomTags()
      const attributes = generateRandomAttributes()
      const isActive = Math.random() > 0.1

      await tenantBClient.query(
        `
        INSERT INTO customer_b2.products (name, description, price, stock_quantity, tags, attributes, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (name) DO NOTHING
      `,
        [
          `Product B2-${suffix}`,
          `Detailed description for product ${suffix} with comprehensive specifications and features`,
          price,
          stockQuantity,
          tags,
          JSON.stringify(attributes),
          isActive
        ]
      )
    }

    // Get actual user IDs for orders
    const userIdsB2 = await tenantBClient.query(
      `
      SELECT id FROM customer_b2.users ORDER BY RANDOM() LIMIT $1
    `,
      [numOrders]
    )

    // Insert random orders
    for (const row of userIdsB2.rows) {
      const totalAmount = generateRandomTotal()
      const status = getRandomOrderStatus()
      const notes = generateRandomNotes()

      await tenantBClient.query(
        `
        INSERT INTO customer_b2.orders (user_id, total_amount, status, notes)
        VALUES ($1, $2, $3, $4)
      `,
        [row.id, totalAmount, status, notes]
      )
    }
  } finally {
    await tenantBClient.end()
  }
}

async function simulateMySqlActivity(
  credentials: any,
  endpoint: string,
  port: string,
  numUsers: number,
  numProducts: number,
  numOrders: number
): Promise<void> {
  // ---- TENANT A DATABASE ----
  const tenantAConnection = await mysql.createConnection({
    host: endpoint,
    port: parseInt(port),
    user: credentials.username,
    password: credentials.password,
    database: 'tenant_a'
  })

  try {
    console.log('Connected to tenant_a database')

    // Insert random users with enhanced data
    for (let i = 0; i < numUsers; i++) {
      const suffix = generateUniqueSuffix()
      const age = generateRandomAge()
      const balance = generateRandomBalance()
      const status = getRandomUserStatus()

      await tenantAConnection.execute(
        `
        INSERT IGNORE INTO users (name, email, status, age, balance)
        VALUES (?, ?, ?, ?, ?)
      `,
        [`Tenant A User ${suffix}`, `user${suffix}@tenant-a-demo.com`, status, age, balance]
      )
    }

    // Insert random products with enhanced data
    for (let i = 0; i < numProducts; i++) {
      const suffix = generateUniqueSuffix()
      const price = generateRandomPrice()
      const stockQuantity = generateRandomStockQuantity()
      const isActive = Math.random() > 0.1

      await tenantAConnection.execute(
        `
        INSERT INTO products (name, description, price, stock_quantity, is_active)
        VALUES (?, ?, ?, ?, ?)
      `,
        [
          `Tenant A Product ${suffix}`,
          `Description for product ${suffix}`,
          price,
          stockQuantity,
          isActive
        ]
      )
    }

    // Get user IDs for orders
    const [userRows] = await tenantAConnection.execute(
      `
      SELECT id FROM users ORDER BY RAND() LIMIT ?
    `,
      [numOrders]
    )

    // Insert random orders
    for (const row of userRows as any[]) {
      const totalAmount = generateRandomTotal()
      const status = getRandomOrderStatus()
      const notes = generateRandomNotes()

      await tenantAConnection.execute(
        `
        INSERT INTO orders (user_id, total_amount, status, notes)
        VALUES (?, ?, ?, ?)
      `,
        [row.id, totalAmount, status, notes]
      )
    }
  } finally {
    await tenantAConnection.end()
  }

  // ---- TENANT B DATABASE ----
  const tenantBConnection = await mysql.createConnection({
    host: endpoint,
    port: parseInt(port),
    user: credentials.username,
    password: credentials.password,
    database: 'tenant_b'
  })

  try {
    console.log('Connected to tenant_b database')

    // Insert random users
    for (let i = 0; i < numUsers; i++) {
      const suffix = generateUniqueSuffix()
      const age = generateRandomAge()
      const balance = generateRandomBalance()
      const status = getRandomUserStatus()

      await tenantBConnection.execute(
        `
        INSERT IGNORE INTO users (name, email, status, age, balance)
        VALUES (?, ?, ?, ?, ?)
      `,
        [`Tenant B User ${suffix}`, `user${suffix}@tenant-b-demo.com`, status, age, balance]
      )
    }

    // Insert random products
    for (let i = 0; i < numProducts; i++) {
      const suffix = generateUniqueSuffix()
      const price = generateRandomPrice()
      const stockQuantity = generateRandomStockQuantity()
      const isActive = Math.random() > 0.1

      await tenantBConnection.execute(
        `
        INSERT INTO products (name, description, price, stock_quantity, is_active)
        VALUES (?, ?, ?, ?, ?)
      `,
        [
          `Tenant B Product ${suffix}`,
          `Description for product ${suffix}`,
          price,
          stockQuantity,
          isActive
        ]
      )
    }

    // Get user IDs for orders
    const [userRows] = await tenantBConnection.execute(
      `
      SELECT id FROM users ORDER BY RAND() LIMIT ?
    `,
      [numOrders]
    )

    // Insert random orders
    for (const row of userRows as any[]) {
      const totalAmount = generateRandomTotal()
      const status = getRandomOrderStatus()
      const notes = generateRandomNotes()

      await tenantBConnection.execute(
        `
        INSERT INTO orders (user_id, total_amount, status, notes)
        VALUES (?, ?, ?, ?)
      `,
        [row.id, totalAmount, status, notes]
      )
    }
  } finally {
    await tenantBConnection.end()
  }
}
