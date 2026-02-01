require 'yaml'

Vagrant.configure("2") do |config|
  config.vm.box = "bento/ubuntu-22.04"
  config.vm.box_version = "202510.26.0"

  # Đọc thông tin từ Inventory YAML
  inventory = YAML.load_file('ansible/inventory.yml')
  nodes = inventory['all']['hosts']
  
  # Đọc SSH Key của bạn từ máy Mac
  ssh_pub_key = File.read(File.expand_path("./ssh_keys/id_rsa.pub"))

  nodes.each do |hostname, info|
    config.vm.define hostname do |node|
      node.vm.hostname = hostname
      node.vm.network "private_network", ip: info['ansible_host']

      node.vm.provider "vmware_desktop" do |vmw|
        vmw.memory = info['memory'] || 3048
        vmw.cpus = info['cpu'] || 2
        vmw.vmx["ethernet0.virtualDev"] = "vmxnet3" # Tối ưu mạng cho chip M4
      end

      # SỬ DỤNG CLOUD-INIT ĐỂ TẠO USER UBUNTU TRƯỚC KHI SSH LÊN
      node.vm.provision "shell", inline: <<-SHELL
        if ! id "ubuntu" >/dev/null 2>&1; then
          useradd -m -s /bin/bash ubuntu
          echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/ubuntu
          mkdir -p /home/ubuntu/.ssh
          echo "#{ssh_pub_key}" > /home/ubuntu/.ssh/authorized_keys
          chown -R ubuntu:ubuntu /home/ubuntu/.ssh
          chmod 700 /home/ubuntu/.ssh
          chmod 600 /home/ubuntu/.ssh/authorized_keys
        fi
      SHELL
    end
  end
end