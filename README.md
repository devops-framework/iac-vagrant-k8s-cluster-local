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

Install via Homebrew:
```bash
brew install --cask vagrant vmware-fusion
brew install ansible
vagrant plugin install vagrant-vmware-desktop
```

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