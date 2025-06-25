# Use official Amazon Linux 2023 base image
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# Install all dependencies in single optimized layer
RUN dnf update -y && \
    dnf install -y \
        postgresql16 \
        jq \
        unzip \
        ca-certificates \
        shadow-utils \
        && \
    # Install AWS CLI v2
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    # Create application user
    groupadd -r ddluser && \
    useradd -r -g ddluser -d /app -s /bin/bash ddluser && \
    # Create working directory
    mkdir -p /app && \
    chown -R ddluser:ddluser /app && \
    # Cleanup to reduce image size
    rm -rf awscliv2.zip aws && \
    dnf clean all && \
    rm -rf /var/cache/dnf /tmp/* /var/tmp/*

# Copy application files
COPY --chown=ddluser:ddluser extract-ddl.sh /usr/local/bin/extract-ddl.sh
RUN chmod +x /usr/local/bin/extract-ddl.sh

# Verify installations (fail fast if something is wrong)
RUN pg_dump --version && \
    aws --version && \
    jq --version

# Switch to non-root user
USER ddluser
WORKDIR /app

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pg_dump --version || exit 1

# Default command
ENTRYPOINT ["/usr/local/bin/extract-ddl.sh"]