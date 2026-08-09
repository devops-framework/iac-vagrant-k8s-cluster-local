#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

required_commands=(ansible-playbook helm kubectl python3 ruby)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command_name" >&2
    exit 1
  fi
done

echo '== Ruby/Vagrantfile syntax =='
ruby -c Vagrantfile

echo '== Ansible syntax =='
ANSIBLE_CONFIG=ansible.cfg ansible-playbook \
  -i ansible/inventory.yml ansible/playbook.yml --syntax-check

echo '== Platform manifest syntax =='
python3 - <<'PY'
from pathlib import Path

import yaml

paths = (
    Path("ansible/roles/platform-bootstrap/files/namespaces.yml"),
    Path("ansible/roles/platform-bootstrap/files/network-policies.yml"),
    Path("ansible/roles/github-rac/files/runner-service-account.yml"),
)
for path in paths:
    documents = [document for document in yaml.safe_load_all(path.read_text()) if document]
    if not documents:
        raise SystemExit(f"No Kubernetes resources found in {path}")
    for document in documents:
        if not document.get("apiVersion") or not document.get("kind"):
            raise SystemExit(f"Invalid Kubernetes resource in {path}")
PY

echo '== Helm lint and render =='
helm lint app-deploy-example -f app-deploy-example/values-dev.yml
helm template app-deploy-example app-deploy-example \
  -f app-deploy-example/values-dev.yml >/dev/null

echo '== Kustomize render =='
kubectl kustomize devops/cd/k8s/base >/dev/null
kubectl kustomize devops/cd/k8s/overlays/staging >/dev/null

if command -v kubeconform >/dev/null 2>&1; then
  echo '== Kubernetes schema validation =='
  kubeconform -strict -summary -kubernetes-version 1.28.10 \
    ansible/roles/platform-bootstrap/files/namespaces.yml \
    ansible/roles/platform-bootstrap/files/network-policies.yml \
    ansible/roles/github-rac/files/runner-service-account.yml
  kubectl kustomize devops/cd/k8s/base | \
    kubeconform -strict -summary -kubernetes-version 1.28.10
  kubectl kustomize devops/cd/k8s/overlays/staging | \
    kubeconform -strict -summary -kubernetes-version 1.28.10
else
  echo '== Kubernetes schema validation skipped (kubeconform not installed) =='
fi

if command -v actionlint >/dev/null 2>&1; then
  echo '== GitHub Actions syntax =='
  actionlint -ignore 'SC2086:'
fi

if command -v shellcheck >/dev/null 2>&1; then
  echo '== Shell scripts =='
  shellcheck scripts/validate.sh
fi

echo 'All repository validations passed.'
