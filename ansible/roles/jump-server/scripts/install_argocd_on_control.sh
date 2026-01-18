#!/bin/bash
set -euo pipefail

# Usage: install_argocd_on_control.sh <ansible_user>
ANSIBLE_USER="${1:-ubuntu}"
HOME_DIR="/home/${ANSIBLE_USER}"
KUBECONFIG_PATH="${HOME_DIR}/.kube/config"

# create namespace and apply Argo CD manifests
kubectl --kubeconfig="$KUBECONFIG_PATH" create namespace argocd || true
kubectl --kubeconfig="$KUBECONFIG_PATH" apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# wait for argocd-server deployment (best-effort)
kubectl --kubeconfig="$KUBECONFIG_PATH" -n argocd rollout status deployment/argocd-server --timeout=180s || true

# expose argocd-server as NodePort so VIP/HAProxy can reach it on the NodePort range
kubectl --kubeconfig="$KUBECONFIG_PATH" -n argocd patch svc argocd-server -p '{"spec":{"type":"NodePort"}}' || true

# get nodePort (prefer port with port 443)
nodePort=$(kubectl --kubeconfig="$KUBECONFIG_PATH" -n argocd get svc argocd-server -o jsonpath='{.spec.ports[?(@.port==443)].nodePort}')
if [ -z "$nodePort" ]; then
  nodePort=$(kubectl --kubeconfig="$KUBECONFIG_PATH" -n argocd get svc argocd-server -o jsonpath='{.spec.ports[0].nodePort}')
fi

# read initial admin password and save it to control plane home
if kubectl --kubeconfig="$KUBECONFIG_PATH" -n argocd get secret argocd-initial-admin-secret >/dev/null 2>&1; then
  initial_pass=$(kubectl --kubeconfig="$KUBECONFIG_PATH" -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)
else
  initial_pass=$(kubectl --kubeconfig="$KUBECONFIG_PATH" -n argocd get secret argocd-secret -o jsonpath='{.data.admin\.password}' | base64 -d || true)
fi

echo "$initial_pass" > "${HOME_DIR}/argocd_initial_admin_password.txt" || true
chown ${ANSIBLE_USER}:${ANSIBLE_USER} "${HOME_DIR}/argocd_initial_admin_password.txt" || true

# Print nodePort and password to stdout for logs
echo "ARGOCD_NODEPORT=${nodePort}"
echo "ARGOCD_INITIAL_ADMIN_PASSWORD=${initial_pass}"
