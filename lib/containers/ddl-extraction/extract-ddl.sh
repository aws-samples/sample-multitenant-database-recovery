#!/bin/bash
# DDL Extraction Script for PostgreSQL databases
# Uses pg_dump to extract complete schema and splits into pre/post DMS parts

set -euo pipefail

# Configuration from environment variables
DB_SECRET_ARN="${DB_SECRET_ARN:-}"
DB_NAME="${DB_NAME:-postgres}"
TARGET_SCHEMAS="${TARGET_SCHEMAS:-}"
RECOVERY_SUFFIX="${RECOVERY_SUFFIX:-}"
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-}"

# Task token for Step Functions integration
TASK_TOKEN="${TASK_TOKEN:-}"

# Database connection variables (will be populated from secrets)
DB_HOST=""
DB_PORT=""
DB_USER=""
DB_PASSWORD=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Validate required environment variables
validate_environment() {
    log_info "Validating environment variables..."
    
    local required_vars=(
        "DB_SECRET_ARN" "DB_NAME" 
        "TARGET_SCHEMAS" "RECOVERY_SUFFIX" "S3_BUCKET"
    )
    
    for var in "${required_vars[@]}"; do
        if [[ -z "${!var:-}" ]]; then
            log_error "Required environment variable $var is not set"
            exit 1
        fi
    done
    
    log_success "Environment validation complete"
}

# Retrieve database credentials from AWS Secrets Manager
retrieve_database_credentials() {
    log_info "Retrieving database credentials from Secrets Manager..."
    
    # Get secret value from AWS Secrets Manager
    local secret_json=$(aws secretsmanager get-secret-value \
        --secret-id "$DB_SECRET_ARN" \
        --query SecretString \
        --output text 2>/dev/null)
    
    if [[ $? -ne 0 ]] || [[ -z "$secret_json" ]]; then
        log_error "Failed to retrieve secret from Secrets Manager: $DB_SECRET_ARN"
        exit 1
    fi
    
    # Parse JSON and extract database connection details
    DB_HOST=$(echo "$secret_json" | jq -r '.host // empty')
    DB_PORT=$(echo "$secret_json" | jq -r '.port // 5432')
    DB_USER=$(echo "$secret_json" | jq -r '.username // "postgres"')
    DB_PASSWORD=$(echo "$secret_json" | jq -r '.password // empty')
    
    # Validate that we got the required fields
    if [[ -z "$DB_HOST" ]] || [[ -z "$DB_PASSWORD" ]]; then
        log_error "Secret does not contain required fields: host and password"
        log_error "Secret content keys: $(echo "$secret_json" | jq -r 'keys[]' | tr '\n' ', ')"
        exit 1
    fi
    
    # Convert port to string if it's not already
    DB_PORT="${DB_PORT:-5432}"
    
    log_success "Database credentials retrieved successfully"
    log_info "Database host: $DB_HOST:$DB_PORT"
    log_info "Database user: $DB_USER"
    log_info "Database name: $DB_NAME"
}

# Test database connectivity
test_connection() {
    log_info "Testing database connectivity..."
    
    export PGPASSWORD="$DB_PASSWORD"
    
    if pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME"; then
        log_success "Database is ready"
    else
        log_error "Cannot connect to database"
        exit 1
    fi
    
    # Test actual connection with query
    if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT version();" > /dev/null; then
        log_success "Database connection test successful"
    else
        log_error "Database connection test failed"
        exit 1
    fi
}

# Extract complete DDL using pg_dump
extract_ddl() {
    log_info "Extracting DDL using pg_dump..."
    
    export PGPASSWORD="$DB_PASSWORD"

    # Handle wildcard case - get actual schema names from database
    if [[ "$TARGET_SCHEMAS" == "%" ]]; then
        log_info "Wildcard '%' detected - querying database for all user schemas..."
        
        # Query for all non-system schemas
        local schema_query="SELECT schema_name FROM information_schema.schemata 
                           WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
                           AND schema_name NOT LIKE 'pg_temp_%'
                           AND schema_name NOT LIKE 'pg_toast_temp_%'
                           ORDER BY schema_name;"
        
        local actual_schemas=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
                              -t -c "$schema_query" | tr -d ' ' | grep -v '^$')
        
        if [[ -z "$actual_schemas" ]]; then
            log_error "No user schemas found in database"
            exit 1
        fi
        
        # Convert newline-separated to comma-separated
        TARGET_SCHEMAS=$(echo "$actual_schemas" | tr '\n' ',' | sed 's/,$//')
        log_info "Found schemas: $TARGET_SCHEMAS"
    fi
    
    # Convert comma-separated schemas to array
    IFS=',' read -ra SCHEMA_ARRAY <<< "$TARGET_SCHEMAS"
    
    # Build schema filter for pg_dump
    local schema_options=""
    for schema in "${SCHEMA_ARRAY[@]}"; do
        schema_options="$schema_options --schema=$schema"
    done
    
    # Extract complete schema-only dump
    log_info "Running pg_dump for schemas: $TARGET_SCHEMAS"
    
    pg_dump \
        --host="$DB_HOST" \
        --port="$DB_PORT" \
        --username="$DB_USER" \
        --dbname="$DB_NAME" \
        --schema-only \
        --no-owner \
        --no-privileges \
        --no-tablespaces \
        --no-security-labels \
        --no-comments \
        $schema_options \
        --file="/app/complete_schema.sql"
    
    if [[ ! -f "/app/complete_schema.sql" ]]; then
        log_error "pg_dump failed to create schema file"
        exit 1
    fi
    
    local line_count=$(wc -l < "/app/complete_schema.sql")
    log_success "DDL extraction complete: $line_count lines extracted"
}

# Transform schema names for recovery
transform_schema_names() {
    log_info "Transforming schema names for recovery..."
    
    cp "/app/complete_schema.sql" "/app/transformed_schema.sql"
    
    # Convert comma-separated schemas to array
    IFS=',' read -ra SCHEMA_ARRAY <<< "$TARGET_SCHEMAS"
    
    for schema in "${SCHEMA_ARRAY[@]}"; do
        local recovery_schema="${schema}${RECOVERY_SUFFIX}"
        log_info "Transforming $schema -> $recovery_schema"
        
        # Transform schema references
        sed -i "s/CREATE SCHEMA ${schema};/CREATE SCHEMA IF NOT EXISTS ${recovery_schema};/g" "/app/transformed_schema.sql"
        sed -i "s/\\b${schema}\\./${recovery_schema}./g" "/app/transformed_schema.sql"
        sed -i "s/REFERENCES ${schema}\\./REFERENCES ${recovery_schema}./g" "/app/transformed_schema.sql"
        sed -i "s/\"${schema}\"/\"${recovery_schema}\"/g" "/app/transformed_schema.sql"
    done
    
    log_success "Schema name transformation complete"
}

# Split DDL into pre-DMS and post-DMS parts
split_ddl() {
    log_info "Splitting DDL into pre-DMS and post-DMS parts..."
    
    # Initialize output files
    cat > "/app/pre_dms_ddl.sql" << 'EOF'
-- ===================================
-- PRE-DMS DDL for Database Recovery
-- Generated by pg_dump and split automatically
-- Contains: Schemas, Tables, Sequences, Primary Keys
-- ===================================

EOF

    cat > "/app/post_dms_ddl.sql" << 'EOF'
-- ===================================
-- POST-DMS DDL for Database Recovery  
-- Generated by pg_dump and split automatically
-- Contains: Foreign Keys, Indexes, Constraints, Views, Functions, Triggers
-- ===================================

EOF

    # Process the transformed schema file line by line
    local current_statement=""
    local in_function=false
    
    while IFS= read -r line; do
        # Skip comments and empty lines for classification
        if [[ "$line" =~ ^[[:space:]]*$ ]] || [[ "$line" =~ ^[[:space:]]*-- ]]; then
            current_statement="$current_statement$line"$'\n'
            continue
        fi
        
        current_statement="$current_statement$line"$'\n'
        
        # Check for function definitions (multi-line)
        if [[ "$line" =~ CREATE.*FUNCTION ]] || [[ "$line" =~ CREATE.*OR.*REPLACE.*FUNCTION ]]; then
            in_function=true
        fi
        
        # End of statement detection
        if [[ "$line" =~ \;[[:space:]]*$ ]] && [[ "$in_function" == false ]]; then
            classify_and_write_statement "$current_statement"
            current_statement=""
        elif [[ "$line" =~ \$\$[[:space:]]*\;[[:space:]]*$ ]] && [[ "$in_function" == true ]]; then
            # End of function
            classify_and_write_statement "$current_statement"
            current_statement=""
            in_function=false
        fi
        
    done < "/app/transformed_schema.sql"
    
    # Handle any remaining statement
    if [[ -n "$current_statement" ]]; then
        classify_and_write_statement "$current_statement"
    fi
    
    log_success "DDL splitting complete"
    
    # Show statistics
    local pre_lines=$(wc -l < "/app/pre_dms_ddl.sql")
    local post_lines=$(wc -l < "/app/post_dms_ddl.sql")
    log_info "Pre-DMS DDL: $pre_lines lines"
    log_info "Post-DMS DDL: $post_lines lines"
}

# Enhanced DDL classification function - handles all PostgreSQL DDL types properly
classify_and_write_statement() {
    local statement="$1"
    local statement_upper=$(echo "$statement" | tr '[:lower:]' '[:upper:]')
    
    # Skip PostgreSQL configuration statements (they're not DDL)
    if [[ "$statement_upper" =~ ^SET[[:space:]] ]] || \
       [[ "$statement_upper" =~ ^SELECT[[:space:]]+PG_CATALOG\.SET_CONFIG ]] || \
       [[ "$statement_upper" =~ ^--[[:space:]] ]] || \
       [[ "$statement" =~ ^[[:space:]]*$ ]]; then
        # Skip these - they're session configuration, not DDL
        return
    fi
    
    # Pre-DMS statements (needed before data migration)
    # These create the foundation that tables and data depend on
    if [[ "$statement_upper" =~ CREATE[[:space:]]+SCHEMA ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+EXTENSION ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+LANGUAGE ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+TYPE ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+DOMAIN ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+COLLATION ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+CAST ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+OPERATOR ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+AGGREGATE ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+FUNCTION ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+OR[[:space:]]+REPLACE[[:space:]]+FUNCTION ]] || \
       [[ "$statement_upper" =~ ALTER[[:space:]]+FUNCTION ]] || \
       [[ "$statement_upper" =~ ALTER[[:space:]]+TYPE ]] || \
       [[ "$statement_upper" =~ ALTER[[:space:]]+DOMAIN ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+SEQUENCE ]] || \
       [[ "$statement_upper" =~ ALTER[[:space:]]+SEQUENCE.*OWNED[[:space:]]+BY ]] || \
       [[ "$statement_upper" =~ CREATE[[:space:]]+TABLE ]] || \
       [[ "$statement_upper" =~ ALTER[[:space:]]+TABLE.*ADD[[:space:]]+CONSTRAINT.*PRIMARY[[:space:]]+KEY ]]; then
        echo "$statement" >> "/app/pre_dms_ddl.sql"
    
    # Post-DMS statements (applied after data migration)
    # These add constraints and optimizations that can interfere with data loading
    elif [[ "$statement_upper" =~ CREATE[[:space:]]+INDEX ]] || \
         [[ "$statement_upper" =~ CREATE[[:space:]]+UNIQUE[[:space:]]+INDEX ]] || \
         [[ "$statement_upper" =~ ALTER[[:space:]]+TABLE.*ADD[[:space:]]+CONSTRAINT.*FOREIGN[[:space:]]+KEY ]] || \
         [[ "$statement_upper" =~ ALTER[[:space:]]+TABLE.*ADD[[:space:]]+CONSTRAINT.*UNIQUE ]] || \
         [[ "$statement_upper" =~ ALTER[[:space:]]+TABLE.*ADD[[:space:]]+CONSTRAINT.*CHECK ]] || \
         [[ "$statement_upper" =~ CREATE[[:space:]]+VIEW ]] || \
         [[ "$statement_upper" =~ CREATE[[:space:]]+OR[[:space:]]+REPLACE[[:space:]]+VIEW ]] || \
         [[ "$statement_upper" =~ CREATE[[:space:]]+MATERIALIZED[[:space:]]+VIEW ]] || \
         [[ "$statement_upper" =~ CREATE[[:space:]]+TRIGGER ]] || \
         [[ "$statement_upper" =~ CREATE[[:space:]]+RULE ]] || \
         [[ "$statement_upper" =~ CREATE[[:space:]]+POLICY ]] || \
         [[ "$statement_upper" =~ ALTER[[:space:]]+TABLE.*ENABLE[[:space:]]+ROW[[:space:]]+LEVEL[[:space:]]+SECURITY ]] || \
         [[ "$statement_upper" =~ ALTER[[:space:]]+TABLE.*DISABLE[[:space:]]+ROW[[:space:]]+LEVEL[[:space:]]+SECURITY ]]; then
        echo "$statement" >> "/app/post_dms_ddl.sql"
    
    # Ownership and permission statements (post-DMS)
    elif [[ "$statement_upper" =~ COMMENT[[:space:]]+ON ]] || \
         [[ "$statement_upper" =~ ALTER[[:space:]]+.*OWNER[[:space:]]+TO ]] || \
         [[ "$statement_upper" =~ REVOKE ]] || \
         [[ "$statement_upper" =~ GRANT ]] || \
         [[ "$statement_upper" =~ ALTER[[:space:]]+DEFAULT[[:space:]]+PRIVILEGES ]]; then
        echo "$statement" >> "/app/post_dms_ddl.sql"
    
    # For truly unclassified statements, show more context and add to post-DMS
    else
        # Show first 100 characters for debugging
        local preview=$(echo "$statement" | head -c 100 | tr '\n' ' ')
        log_warning "Unclassified statement, adding to post-DMS: $preview..."
        echo "$statement" >> "/app/post_dms_ddl.sql"
    fi
}

# Upload DDL files to S3
upload_to_s3() {
    log_info "Uploading DDL files to S3..."
    
    local timestamp=$(date -u +"%Y%m%d-%H%M%S")
    local base_key="$S3_PREFIX/$DB_NAME"
    local export_timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    
    # Escape target schemas for metadata (replace commas with semicolons to avoid AWS CLI parsing issues)
    local escaped_schemas=$(echo "$TARGET_SCHEMAS" | sed 's/,/;/g')
    
    # Upload pre-DMS DDL
    local pre_dms_key="$base_key/pre-dms-ddl-$timestamp.sql"
    aws s3 cp "/app/pre_dms_ddl.sql" "s3://$S3_BUCKET/$pre_dms_key"
    
    local pre_dms_url="s3://$S3_BUCKET/$pre_dms_key"
    log_success "Pre-DMS DDL uploaded: $pre_dms_url"
    
    # Upload post-DMS DDL  
    local post_dms_key="$base_key/post-dms-ddl-$timestamp.sql"
    aws s3 cp "/app/post_dms_ddl.sql" "s3://$S3_BUCKET/$post_dms_key" 
    
    local post_dms_url="s3://$S3_BUCKET/$post_dms_key"
    log_success "Post-DMS DDL uploaded: $post_dms_url"
    
    # Upload complete schema for reference
    local complete_key="$base_key/complete-schema-$timestamp.sql"
    aws s3 cp "/app/transformed_schema.sql" "s3://$S3_BUCKET/$complete_key"
    
    local complete_url="s3://$S3_BUCKET/$complete_key"
    log_success "Complete schema uploaded: $complete_url"
    
    # Prepare result for Step Functions
    local result_json=$(cat << EOF
{
    "statusCode": 200,
    "preDMSObjectUrl": "$pre_dms_url",
    "preDMSObjectKey": "$pre_dms_key", 
    "postDMSObjectUrl": "$post_dms_url",
    "postDMSObjectKey": "$post_dms_key",
    "completeSchemaUrl": "$complete_url",
    "completeSchemaKey": "$complete_key",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "targetSchemas": "$TARGET_SCHEMAS",
    "linesExtracted": $(wc -l < "/app/transformed_schema.sql")
}
EOF
    )
    
    echo "$result_json" > "/app/result.json"
    log_info "Result JSON prepared for Step Functions"
}

# Send success result to Step Functions
send_success() {
    if [[ -n "$TASK_TOKEN" ]]; then
        log_info "Sending success result to Step Functions..."
        
        local result_json=$(cat "/app/result.json")
        
        aws stepfunctions send-task-success \
            --task-token "$TASK_TOKEN" \
            --task-output "$result_json"
        
        log_success "Success result sent to Step Functions"
    else
        log_warning "No task token provided, skipping Step Functions notification"
    fi
}

# Send failure result to Step Functions
send_failure() {
    local error_message="$1"
    
    if [[ -n "$TASK_TOKEN" ]]; then
        log_error "Sending failure result to Step Functions: $error_message"
        
        aws stepfunctions send-task-failure \
            --task-token "$TASK_TOKEN" \
            --error "DDLExtractionError" \
            --cause "$error_message"
    else
        log_error "DDL extraction failed: $error_message"
    fi
    
    exit 1
}

# Main execution
main() {
    log_info "Starting DDL extraction process..."
    
    # Set trap for error handling
    trap 'send_failure "DDL extraction failed at line $LINENO"' ERR
    
    validate_environment
    retrieve_database_credentials
    test_connection
    extract_ddl
    transform_schema_names
    split_ddl
    upload_to_s3
    send_success
    
    log_success "DDL extraction process completed successfully"
}

# Run main function
main "$@"