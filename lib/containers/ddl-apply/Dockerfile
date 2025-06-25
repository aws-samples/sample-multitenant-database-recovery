# Use official Amazon Linux 2023 base image
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# Install all dependencies in single optimized layer
RUN dnf update -y && \
    dnf install -y \
        nodejs20 \
        npm \
        postgresql16 \
        unzip \
        ca-certificates \
        shadow-utils \
        && \
    # Install AWS CLI v2
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    # Create application user
    groupadd -r nodeuser && \
    useradd -r -g nodeuser -d /app -s /bin/bash nodeuser && \
    # Create working directory
    mkdir -p /app && \
    chown -R nodeuser:nodeuser /app && \
    # Cleanup to reduce image size
    rm -rf awscliv2.zip aws && \
    dnf clean all && \
    rm -rf /var/cache/dnf /tmp/* /var/tmp/*

# Switch to app directory and user
WORKDIR /app
USER nodeuser

# Copy package files for dependency installation
COPY --chown=nodeuser:nodeuser package.json package-lock.json* ./

# Install Node.js dependencies as non-root user
RUN npm install && npm cache clean --force

# Copy application files
COPY --chown=nodeuser:nodeuser *.js ./
COPY --chown=nodeuser:nodeuser global-bundle.pem ./

# Verify installations (fail fast if something is wrong)
RUN node --version && \
    npm --version && \
    psql --version && \
    aws --version

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node --version || exit 1

# Default command
ENTRYPOINT ["node", "index.js"]