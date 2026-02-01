# DevOps Lab (Vagrant + VMware Fusion + Ansible)

## 📌 Overview
This lab creates an **Ubuntu ARM64 VM** on **VMware Fusion (Apple Silicon)**  
Provisioned with **Ansible** to install:
- Terraform, Packer, Ansible (IaC tools)
- Docker, kubectl, Helm (container tools)

## 🚀 Requirements
- macOS (M1/M2/M3/M4)
- [VMware Fusion 13.5+](https://customerconnect.vmware.com/)
- [Vagrant](https://developer.hashicorp.com/vagrant/downloads)
- [Ansible](https://docs.ansible.com/ansible/latest/installation_guide/intro_installation.html)
- [Vagrant base image](https://portal.cloud.hashicorp.com/vagrant/discover?architectures=arm64&providers=%5B%22vmware_fusion%22%2C%22vmware_desktop%22%5D&query=ubuntu)

Install via Homebrew:
```bash
brew install --cask vagrant vmware-fusion
brew install ansible
vagrant plugin install vagrant-vmware-desktop
```

## GUIDELINES

### 🛠 Project Architecture
* **Nodes:** 1 Master, 2 Workers, 1 Load Balancer (VIP-LB).
* **Stack:** RKE2, ArgoCD, GitHub Actions Runner Controller (ARC).
* **Automation:** Vagrant for Infrastructure, Ansible for Configuration Management.
#### Pre-installation
Before spinning up the cluster, you must configure your secrets and environment variables.

* **Configure GitHub PAT:**
  Open `ansible/group_vars/all.yml` and provide your GitHub Personal Access Token (PAT). This is required for the Actions Runner Controller.
  ```yaml
  github_pat: "ghp_your_secret_token_here"
  ```

Ensure you have the necessary Ansible collections on your Mac:

```bash
ansible-galaxy collection install ansible.posix kubernetes.core
```

#### Installation

Step 1: Provision Virtual Machines
Start the VMs defined in the Vagrantfile.
```bash
vagrant up
```

Step 2: Verify Connectivity
Ensure that Ansible can reach all 4 nodes via SSH.

```bash
ansible all -m ping
```

Step 3: Deploy Kubernetes Cluster
Execute the main playbook to install RKE2, ArgoCD, and Runners. We use --flush-cache to ensure a clean state of system facts.

```bash
ansible-playbook ansible/playbook.yml --flush-cache
```

#### Cleanup
To completely wipe the environment and free up system resources:

Destroy VMs:
```bash
vagrant destroy -f
```

Remove Local Metadata:
```bash
rm -rf .vagrant/
```

## Optional
#### Check current status of VMs:
```bash
vagrant status 
```

#### Start VMs
```bash
vagrant up
```

#### Stop VMs
```bash
vagrant halt # Recommend
vagrant suspend
```

#### Resume VMs
```bash
vagrant resume
```

#### Destroy VMs
```bash
vagrant destroy -f 
```

Ref:
https://viblo.asia/p/cach-tao-kubernetesk8s-cluster-home-lab-bang-ubuntu-server-2404-qPoL7YjN4vk

Create ssh_keys folder in root
Copy private and public ssh key to ssh_keys folder

Test helm:

```bash
helm template vote-app-100 ./ -n vote-app -f values-dev.yml -s templates/deployment.yml

# Deploy:
helm install vote-app-100 ./ -n vote-app -f values-dev.yml
helm upgrade vote-app-100 ./ -n vote-app -f values-dev.yml

# Debug
kubectl get pod -n vote-app -o wide # Get name
kubectl exec -it xxx -n vote-app -- sh # ssh inside the pod

# Destroy
helm uninstall vote-app-100 -n vote-app

# Cleanup all resources in namespace
kubectl delete all --all -n <tên-namespace>
```