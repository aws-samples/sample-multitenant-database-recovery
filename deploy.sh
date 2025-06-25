#!/bin/bash
# DATABASE-LEVEL RDS RECOVERY SOLUTION - Deployment Script

# Colors
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly BOLD='\033[1m'
readonly NC='\033[0m'

# Global Variables
VERBOSE=false
selected_database=""

# Parse command line arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --verbose) VERBOSE=true ;;
        *) echo -e "${RED}Unknown parameter passed: $1${NC}"; exit 1 ;;
    esac
    shift
done

# Print functions
print_info() { echo -e "${CYAN}➤ $1${NC}"; }
print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠ $1${NC}"; }
print_error() { echo -e "${RED}✗ $1${NC}"; }
print_header() { echo -e "\n${BOLD}${BLUE}=== $1 ===${NC}\n"; }
print_detail() { echo -e "  → $1"; }

# Database types
declare -a DB_TYPES=(
  "SingleAz|PostgreSQL Single-AZ"
  "MultiAz|PostgreSQL Multi-AZ"
  "AuroraProvisioned|Aurora PostgreSQL Provisioned"
  "AuroraServerless|Aurora PostgreSQL Serverless"
)

# Get database key from array
get_db_key() {
  echo "$1" | cut -d'|' -f1
}

# Get database display name from array
get_db_display() {
  echo "$1" | cut -d'|' -f2
}

# Yes/No prompt
yes_no_prompt() {
  local prompt="$1"
  local default="${2:-n}"
  
  if [ "$default" = "y" ]; then
    prompt="$prompt [Y/n]"
  else
    prompt="$prompt [y/N]"
  fi
  
  read -p "$(echo -e "${YELLOW}? ${prompt}:${NC} ")" yn
  
  # Default value if empty
  if [ -z "$yn" ]; then
    yn=$default
  fi
  
  case $yn in
    [Yy]* ) return 0;;
    * ) return 1;;
  esac
}

# Check prerequisites
check_prerequisites() {
  print_header "Checking Prerequisites"
  
  # Check AWS CLI
  if [ "$VERBOSE" = true ]; then
    printf "%s\n" "[which aws]"
    which aws
  fi
  
  if ! command -v aws &> /dev/null; then
    print_error "AWS CLI not found"
    exit 1
  fi
  print_success "AWS CLI found"
  
  # Check Node.js
  if [ "$VERBOSE" = true ]; then
    printf "%s\n" "[node --version]"
    node --version
  fi
  
  if ! command -v node &> /dev/null; then
    print_error "Node.js not found"
    exit 1
  fi
  print_success "Node.js found ($(node --version))"
  
  # Check npm
  if [ "$VERBOSE" = true ]; then
    printf "%s\n" "[npm --version]"
    npm --version
  fi
  
  if ! command -v npm &> /dev/null; then
    print_error "npm not found"
    exit 1
  fi
  print_success "npm found ($(npm --version))"
  
  # Check Docker
  if [ "$VERBOSE" = true ]; then
    printf "%s\n" "[docker info]"
    docker info
  fi
  
  if ! command -v docker &> /dev/null; then
    print_error "Docker not found"
    exit 1
  fi
  
  if ! docker info &> /dev/null; then
    print_error "Docker is not running"
    exit 1
  fi
  print_success "Docker found and running"
  
  # Check AWS credentials
  if [ "$VERBOSE" = true ]; then
    printf "%s\n" "[aws sts get-caller-identity]"
    aws sts get-caller-identity
  fi
  
  if ! aws sts get-caller-identity &> /dev/null; then
    print_error "AWS credentials not configured"
    exit 1
  fi
  print_success "AWS credentials configured"
  
  print_success "All prerequisites met"
}

# Setup environment
setup_environment() {
  print_header "Setting Up Environment"
  
  # Install dependencies
  print_info "Installing dependencies..."
  
  if [ -f "package-lock.json" ]; then
    print_detail "Found package-lock.json, running npm ci..."
    if [ "$VERBOSE" = true ]; then
      printf "%s\n" "npm ci"
      npm ci
    else
      npm ci --silent
    fi
  else
    print_detail "No package-lock.json found, running npm install..."
    if [ "$VERBOSE" = true ]; then
      printf "%s\n" "npm install"
      npm install
    else
      npm install --silent
    fi
  fi
  
  if [ $? -ne 0 ]; then
    print_error "Failed to install dependencies"
    exit 1
  fi
  print_success "Dependencies installed"
  
  # Build project
  print_info "Building project..."
  print_detail "Running npm run build..."
  
  if [ "$VERBOSE" = true ]; then
    printf "%s\n" "npm run build"
    npm run build
  else
    print_detail "Compiling TypeScript..."
    npm run build --silent &
    build_pid=$!
    
    # Wait for build to complete
    wait $build_pid
    build_result=$?
    
    print_detail "Copying state machine definitions..."
  fi
  
  if [ $? -ne 0 ]; then
    print_error "Failed to build project"
    exit 1
  fi
  print_success "Build completed"
  
  # Check CDK bootstrap
  print_info "Checking CDK bootstrap..."
  
  if [ "$VERBOSE" = true ]; then
    print_detail "Checking CloudFormation stack CDKToolkit..."
    printf "%s\n" "[aws cloudformation describe-stacks --stack-name CDKToolkit]"
    aws cloudformation describe-stacks --stack-name CDKToolkit
  fi
  
  if aws cloudformation describe-stacks --stack-name CDKToolkit &> /dev/null; then
    print_detail "CDK bootstrap already exists"
  else
    print_detail "Bootstrapping CDK..."
    if ! npx aws-cdk bootstrap; then
      print_error "Failed to bootstrap CDK"
      exit 1
    fi
  fi
  
  print_success "Environment ready"
}

# Select databases
select_database() {
  print_header "Select Database"
  
  echo "Choose one database to deploy:"
  echo
  
  # Display database options
  local i=1
  for db_info in "${DB_TYPES[@]}"; do
    local display_name=$(get_db_display "$db_info")
    echo -e " ${BOLD}${i})${NC} $display_name"
    ((i++))
  done
  
  echo -e " ${BOLD}q)${NC} Quit"
  echo
  
  read -p "$(echo -e "${YELLOW}? Enter your choice:${NC} ")" selection
  
  if [ "$selection" = "q" ]; then
    print_info "Goodbye!"
    exit 0
  elif [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#DB_TYPES[@]}" ]; then
    # Valid single number selection
    local idx=$((selection - 1))
    local db_info="${DB_TYPES[$idx]}"
    local db_key=$(get_db_key "$db_info")
    local display_name=$(get_db_display "$db_info")
    
    selected_database="$db_key"
    print_success "Selected: $display_name"
  else
    print_error "Invalid selection: $selection"
    return 1
  fi
  
  return 0
}

# Deploy solution
# Deploy solution
deploy_solution() {
  print_header "Deploy Configuration"
  
  echo
  print_info "Deployment Configuration:"
  print_detail "Selected database: $selected_database"
  echo

  if ! yes_no_prompt "Deploy with this configuration?" "y"; then
    print_info "Deployment cancelled"
    return 0
  fi
  
  print_header "Deploying Solution"
  print_info "Starting CDK deployment..."
  echo
  
  local cdk_command="npx aws-cdk deploy \
    --app \"npx ts-node bin/multienant-database-restore.ts\" \
    --context selectedDatabase=\"$selected_database\" \
    --require-approval never"
  
  # Execute deployment
  eval $cdk_command
  
  if [ $? -eq 0 ]; then
    echo
    print_success "Deployment complete!"
    
    # Show access information
    echo
  fi
}

# Delete all resources
cleanup_resources() {
  print_header "Cleanup"
  
  if ! yes_no_prompt "Delete ALL resources?" "n"; then
    print_info "Cleanup cancelled"
    return 0
  fi
  
  print_info "Deleting all resources..."
  print_detail "Running npx aws-cdk destroy..."
  echo
  
  # CDK always outputs to console
  npx aws-cdk destroy \
    --app "npx ts-node bin/multienant-postgres-restore.ts" \
    --all --force
  
  if [ $? -eq 0 ]; then
    echo
    print_success "Cleanup complete"
  else
    print_error "Cleanup failed"
    return 1
  fi
}

# Main function
main() {
  # Clear screen and show header
  clear
  cat << "EOF"
       
       ⋆⋅⋆━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⋆⋅⋆
       
           DATABASE-LEVEL RDS RECOVERY SOLUTION
       
       ⋆⋅⋆━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━⋆⋅⋆
                         AWS CDK

EOF

  [ "$VERBOSE" = true ] && print_info "Running in verbose mode"
  
  # Check prerequisites
  check_prerequisites
  
  # Setup environment
  setup_environment
  
  # Main menu loop
  while true; do
    print_header "Main Menu"
    echo -e " ${BOLD}1)${NC} Deploy Solution"
    echo -e " ${BOLD}2)${NC} Delete All Resources"
    echo -e " ${BOLD}3)${NC} Exit"
    
    read -p "$(echo -e "${YELLOW}? Choose:${NC} ")" main_choice
    
    case $main_choice in
      1)
        if select_database; then
          deploy_solution
        fi
        ;;
      2)
        cleanup_resources
        ;;
      3)
        print_info "Goodbye!"
        exit 0
        ;;
      *)
        print_error "Invalid choice"
        ;;
    esac
  done
}

# Run main function
main "$@"