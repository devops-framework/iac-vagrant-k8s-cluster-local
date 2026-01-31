Vagrant.configure("2") do |config|
  config.vm.box = "bento/ubuntu-22.04"
  config.vm.box_version = "202510.26.0"
  config.vm.boot_timeout = 600

  # Define cluster nodes: 1 master and 2 workers
  # Use `roles` (array) so a node can receive multiple roles, e.g. master also being a worker
  # You can optionally set per-node `memory` (MB) and `cpus` here. If omitted, the base values are used.
  nodes = [
    # {
    #   name: "master",
    #   ip: "192.168.56.20",
    #   hostname: "devops-master",
    #   roles: ["master", "containers"]
    # },
    # {
    #   name: "worker1",
    #   ip: "192.168.56.21",
    #   hostname: "devops-worker1",
    #   roles: ["worker", "containers"],
    # },
    # {
    #   name: "worker2",
    #   ip: "192.168.56.22",
    #   hostname: "devops-worker2",
    #   roles: ["worker", "containers"]
    # },
    {
      name: "rke2-control-plane-001",
      ip: "192.168.56.11",
      hostname: "rke2-server-001",
      roles: ["rke2-server"]
    },
    {
      name: "rke2-worker-001",
      ip: "192.168.56.12",
      hostname: "rke2-agent-001",
      roles: ["rke2-agent"]
    },
    {
      name: "rke2-worker-002",
      ip: "192.168.56.13",
      hostname: "rke2-agent-002",
      roles: ["rke2-agent"]
    },
    {
      name: "vip-lb",
      ip: "192.168.56.14",
      hostname: "vip-lb",
      roles: ["vip_lb", "jump-server"],
      memory: 1024,
      cpus: 1
    },
  ]

  base_memory = 3048
  base_cpus = 2

  nodes.each do |n|
    config.vm.define n[:name] do |node|
      node.vm.box = config.vm.box
      node.vm.box_version = config.vm.box_version
      node.vm.hostname = n[:hostname]

      node.vm.network "private_network", ip: n[:ip]

      node.vm.provider "vmware_desktop" do |vmw|
        vmw.gui    = false
        # Allow per-node overrides: use n[:memory] / n[:cpus] when provided, otherwise fall back to base values
        vmw.memory = n[:memory] || base_memory
        vmw.cpus   = n[:cpus] || base_cpus
      end

      # Run the Ansible playbook inside each guest (ansible_local)
      node.vm.provision "ansible_local" do |ansible|
        ansible.playbook = "ansible/playbook.yml"
        ansible.become = true
        # Use a vault password file on the host (create ~/.vault_pass.txt with the vault password)
        ansible.vault_password_file = '.vault_pass.txt'
        # Pass selected_roles as an array. If older node entries use :role instead of :roles,
        # fall back to that so this remains backward compatible.
        ansible.extra_vars = {
          selected_roles: (n[:roles] || [n[:role]]),
          node_role: n[:name],
          node_name: n[:hostname],
          cluster_hosts: nodes
        }
        ansible.verbose = "vv"
      end
    end
  end
end
