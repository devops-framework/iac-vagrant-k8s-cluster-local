require 'yaml'
require 'base64'

Vagrant.configure("2") do |config|
  config.vm.box = "bento/ubuntu-22.04"
  config.vm.box_version = "202510.26.0"

  # The default deploys only RKE2. Platform services are opt-in through
  # VAGRANT_DEPLOY=<capability>.
  deploy_target = ENV.fetch('VAGRANT_DEPLOY', 'cluster').strip.downcase
  deploy_tags = {
    'cluster' => 'kubernetes',
    'platform-bootstrap' => 'platform-bootstrap',
    'argocd' => 'platform-bootstrap,argocd',
    'github-runner' => 'platform-bootstrap,github-runner',
    'all' => nil
  }.fetch(deploy_target) do
    raise "Unsupported VAGRANT_DEPLOY=#{deploy_target.inspect}. " \
          "Choose cluster, platform-bootstrap, argocd, github-runner, or all."
  end

  # Đọc thông tin từ Inventory YAML
  inventory = YAML.load_file('ansible/inventory.yml')
  nodes = inventory['all']['hosts']

  # Read the operator's public key without ever committing private key material.
  ssh_pub_key_path = File.expand_path(ENV.fetch('SSH_PUBLIC_KEY_PATH', './ssh_keys/id_rsa.pub'))
  raise "SSH public key not found: #{ssh_pub_key_path}" unless File.file?(ssh_pub_key_path)

  ssh_pub_key = File.read(ssh_pub_key_path).strip
  unless ssh_pub_key.match?(/\A(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+\/=]+(?:\s+.*)?\z/)
    raise "Invalid OpenSSH public key: #{ssh_pub_key_path}"
  end
  ssh_pub_key_base64 = Base64.strict_encode64(ssh_pub_key)

  nodes.each do |hostname, info|
    config.vm.define hostname do |node|
      node.vm.hostname = hostname
      node.vm.network "private_network", ip: info['ansible_host']

      node.vm.provider "vmware_desktop" do |vmw|
        vmw.memory = info['memory'] || 3048
        vmw.cpus = info['cpu'] || 2
        vmw.vmx["ethernet0.virtualDev"] = "vmxnet3" # Tối ưu mạng cho chip M4
      end

      # Ensure the Ansible user and key are configured on every provision run.
      node.vm.provision "shell", inline: <<-SHELL
        if ! id "ubuntu" >/dev/null 2>&1; then
          useradd -m -s /bin/bash ubuntu
        fi

        printf '%s\n' 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu
        chmod 0440 /etc/sudoers.d/ubuntu
        visudo -cf /etc/sudoers.d/ubuntu

        install -d -m 0700 -o ubuntu -g ubuntu /home/ubuntu/.ssh
        printf '%s' '#{ssh_pub_key_base64}' | base64 --decode > /home/ubuntu/.ssh/authorized_keys
        printf '\n' >> /home/ubuntu/.ssh/authorized_keys
        chown ubuntu:ubuntu /home/ubuntu/.ssh/authorized_keys
        chmod 0600 /home/ubuntu/.ssh/authorized_keys
      SHELL

      if hostname == 'rke2-server-001'
        node.vm.provision 'ansible', type: 'ansible', run: 'once' do |ansible|
          ansible.playbook = 'ansible/playbook.yml'
          ansible.inventory_path = 'ansible/inventory.yml'
          ansible.limit = 'all'
          ansible.raw_arguments = ['--tags', deploy_tags] unless deploy_tags.nil?
        end
      end
    end
  end
end
