#!/bin/bash
set -euo pipefail

# Usage: login_argocd_from_vip.sh <control_ip> <ansible_user>
CONTROL_IP="${1:-}"
ANSIBLE_USER="${2:-ubuntu}"
SSH_KEY="/home/${ANSIBLE_USER}/.ssh/id_rsa"
SSH_USER="${ANSIBLE_USER}"

if [ -z "$CONTROL_IP" ]; then
  echo "control_ip is required as first arg" >&2
  exit 2
fi

# Find NodePort for argocd-server
NODEPORT=$(ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$SSH_USER@$CONTROL_IP" "kubectl --kubeconfig=/home/${ANSIBLE_USER}/.kube/config -n argocd get svc argocd-server -o jsonpath='{.spec.ports[?(@.port==443)].nodePort}'" || ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$SSH_USER@$CONTROL_IP" "kubectl --kubeconfig=/home/${ANSIBLE_USER}/.kube/config -n argocd get svc argocd-server -o jsonpath='{.spec.ports[0].nodePort}'" )

# Read initial password saved on control plane
PASS=$(ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$SSH_USER@$CONTROL_IP" "cat /home/${ANSIBLE_USER}/argocd_initial_admin_password.txt" 2>/dev/null || true)

if [ -z "$NODEPORT" ]; then
  echo "Could not determine ArgoCD NodePort" >&2
  exit 1
fi

# Install argocd CLI if missing
if ! command -v /usr/local/bin/argocd >/dev/null 2>&1; then
  curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-arm64 || true
  chmod +x /usr/local/bin/argocd || true
fi

# Attempt login via HAProxy bound on vip-lb (localhost)
if [ -n "$PASS" ]; then
  /usr/local/bin/argocd login 127.0.0.1:$NODEPORT --insecure --username admin --password "$PASS" || true
else
  echo "Initial admin password not found; saved on control plane at /home/${ANSIBLE_USER}/argocd_initial_admin_password.txt" >&2
fi
