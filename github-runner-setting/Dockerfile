FROM ghcr.io/actions/actions-runner:latest

USER root

# Cài đặt các công cụ cơ bản
RUN apt-get update && apt-get install -y \
    wget curl unzip git \
    && rm -rf /var/lib/apt/lists/*

# Cài đặt kubectl (Bản cho ARM64)
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/arm64/kubectl" \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/

# Cài đặt Helm (Bản cho ARM64)
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# FIX LỖI MOUNT: Tạo sẵn các thư mục hệ thống mà K8s hay mount vào
# RUN mkdir -p /var/run/secrets/kubernetes.io/serviceaccount \
#     && mkdir -p /home/runner/_work \
#     && chown -R runner:runner /home/runner/_work

USER runner