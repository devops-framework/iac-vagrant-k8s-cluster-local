Vagrant.configure("2") do |config|
  config.vm.box = "gyptazy/ubuntu22.04-arm64"
  config.vm.box_version = "1.0.1"
  config.vm.boot_timeout = 600

  # Define cluster nodes: 1 master and 2 workers
  nodes = [
    { name: "master",  ip: "192.168.56.20", hostname: "devops-master",  role: "master" },
    { name: "worker1", ip: "192.168.56.21", hostname: "devops-worker1", role: "worker" },
    { name: "worker2", ip: "192.168.56.22", hostname: "devops-worker2", role: "worker" },
  ]

  base_memory = 3072
  base_cpus = 2

  nodes.each do |n|
    config.vm.define n[:name] do |node|
      node.vm.box = config.vm.box
      node.vm.box_version = config.vm.box_version
      node.vm.hostname = n[:hostname]

      node.vm.network "private_network", ip: n[:ip]

      node.vm.provider "vmware_desktop" do |vmw|
        vmw.gui    = true
        vmw.memory = base_memory
        vmw.cpus   = base_cpus
      end

      # Run the Ansible playbook inside each guest (ansible_local)
      node.vm.provision "ansible_local" do |ansible|
        ansible.playbook = "ansible/playbook.yml"
        ansible.become = true
        # Use a vault password file on the host (create ~/.vault_pass.txt with the vault password)
        ansible.vault_password_file = '.vault_pass.txt'
        ansible.extra_vars = {
          selected_role: n[:role],
          node_role: n[:name],
          node_name: n[:hostname],
          cluster_hosts: nodes
        }
        ansible.verbose = "vvv"
      end
    end
  end
end
