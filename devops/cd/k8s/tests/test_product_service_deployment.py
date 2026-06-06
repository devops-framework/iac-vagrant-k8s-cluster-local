"""
Tests for devops/cd/k8s/base/product-service/deployment.yml

Covers the changes introduced in this PR:
  - resources block (requests and limits for memory and CPU)
  - readinessProbe (httpGet on /actuator/health/readiness:8080)
"""

import os
import re
import unittest
import yaml

MANIFEST_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "base",
    "product-service",
    "deployment.yml",
)


def _load_manifest():
    with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _get_container(manifest, name="product-service"):
    containers = (
        manifest["spec"]["template"]["spec"]["containers"]
    )
    for c in containers:
        if c["name"] == name:
            return c
    raise KeyError(f"Container '{name}' not found in manifest")


def _parse_memory_mi(value: str) -> int:
    """Return memory value in mebibytes for simple Mi/Gi quantities."""
    value = str(value).strip()
    match = re.fullmatch(r"(\d+)(Mi|Gi)", value)
    if not match:
        raise ValueError(f"Cannot parse memory quantity: {value!r}")
    amount, unit = int(match.group(1)), match.group(2)
    return amount * 1024 if unit == "Gi" else amount


def _parse_cpu_millicores(value: str) -> int:
    """Return CPU in millicores for simple m or whole-core quantities."""
    value = str(value).strip()
    if value.endswith("m"):
        return int(value[:-1])
    return int(value) * 1000


class TestManifestValidity(unittest.TestCase):
    """Basic YAML and Kubernetes structure checks."""

    def test_manifest_parses_as_valid_yaml(self):
        """The manifest must be parseable YAML without errors."""
        manifest = _load_manifest()
        self.assertIsNotNone(manifest)

    def test_api_version_is_apps_v1(self):
        manifest = _load_manifest()
        self.assertEqual(manifest.get("apiVersion"), "apps/v1")

    def test_kind_is_deployment(self):
        manifest = _load_manifest()
        self.assertEqual(manifest.get("kind"), "Deployment")

    def test_product_service_container_exists(self):
        """The deployment must have a container named 'product-service'."""
        manifest = _load_manifest()
        container = _get_container(manifest)
        self.assertEqual(container["name"], "product-service")


class TestResourceRequests(unittest.TestCase):
    """Validate the 'resources.requests' block added in this PR."""

    def setUp(self):
        self.container = _get_container(_load_manifest())

    def test_resources_block_is_present(self):
        self.assertIn("resources", self.container)

    def test_requests_block_is_present(self):
        self.assertIn("requests", self.container["resources"])

    def test_requests_memory_is_256mi(self):
        memory = self.container["resources"]["requests"]["memory"]
        self.assertEqual(memory, "256Mi")

    def test_requests_cpu_is_250m(self):
        cpu = self.container["resources"]["requests"]["cpu"]
        self.assertEqual(cpu, "250m")

    def test_requests_memory_is_valid_quantity_format(self):
        """Memory request must match a recognised Kubernetes quantity (e.g. 256Mi)."""
        memory = str(self.container["resources"]["requests"]["memory"])
        self.assertRegex(
            memory,
            r"^\d+(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$",
            msg=f"Memory request '{memory}' is not a valid K8s quantity",
        )

    def test_requests_cpu_is_valid_quantity_format(self):
        """CPU request must be a millicores (e.g. 250m) or whole-core value."""
        cpu = str(self.container["resources"]["requests"]["cpu"])
        self.assertRegex(
            cpu,
            r"^\d+m?$",
            msg=f"CPU request '{cpu}' is not a valid K8s quantity",
        )


class TestResourceLimits(unittest.TestCase):
    """Validate the 'resources.limits' block added in this PR."""

    def setUp(self):
        self.container = _get_container(_load_manifest())

    def test_limits_block_is_present(self):
        self.assertIn("limits", self.container["resources"])

    def test_limits_memory_is_512mi(self):
        memory = self.container["resources"]["limits"]["memory"]
        self.assertEqual(memory, "512Mi")

    def test_limits_cpu_is_500m(self):
        cpu = self.container["resources"]["limits"]["cpu"]
        self.assertEqual(cpu, "500m")

    def test_limits_memory_is_valid_quantity_format(self):
        memory = str(self.container["resources"]["limits"]["memory"])
        self.assertRegex(
            memory,
            r"^\d+(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$",
            msg=f"Memory limit '{memory}' is not a valid K8s quantity",
        )

    def test_limits_cpu_is_valid_quantity_format(self):
        cpu = str(self.container["resources"]["limits"]["cpu"])
        self.assertRegex(
            cpu,
            r"^\d+m?$",
            msg=f"CPU limit '{cpu}' is not a valid K8s quantity",
        )


class TestResourceConstraintRelationships(unittest.TestCase):
    """Limits must be >= requests (Kubernetes will reject otherwise)."""

    def setUp(self):
        self.container = _get_container(_load_manifest())

    def test_memory_limit_is_gte_memory_request(self):
        req = _parse_memory_mi(
            self.container["resources"]["requests"]["memory"]
        )
        lim = _parse_memory_mi(
            self.container["resources"]["limits"]["memory"]
        )
        self.assertGreaterEqual(
            lim,
            req,
            msg=f"Memory limit ({lim}Mi) must be >= request ({req}Mi)",
        )

    def test_cpu_limit_is_gte_cpu_request(self):
        req = _parse_cpu_millicores(
            self.container["resources"]["requests"]["cpu"]
        )
        lim = _parse_cpu_millicores(
            self.container["resources"]["limits"]["cpu"]
        )
        self.assertGreaterEqual(
            lim,
            req,
            msg=f"CPU limit ({lim}m) must be >= request ({req}m)",
        )

    def test_memory_limit_is_exactly_2x_request(self):
        """512Mi / 256Mi = 2 — document the intended burst headroom ratio."""
        req = _parse_memory_mi(
            self.container["resources"]["requests"]["memory"]
        )
        lim = _parse_memory_mi(
            self.container["resources"]["limits"]["memory"]
        )
        self.assertEqual(lim, req * 2, msg="Memory limit should be 2x the request")

    def test_cpu_limit_is_exactly_2x_request(self):
        """500m / 250m = 2 — document the intended burst headroom ratio."""
        req = _parse_cpu_millicores(
            self.container["resources"]["requests"]["cpu"]
        )
        lim = _parse_cpu_millicores(
            self.container["resources"]["limits"]["cpu"]
        )
        self.assertEqual(lim, req * 2, msg="CPU limit should be 2x the request")

    def test_requests_memory_is_positive(self):
        req = _parse_memory_mi(
            self.container["resources"]["requests"]["memory"]
        )
        self.assertGreater(req, 0)

    def test_limits_memory_is_positive(self):
        lim = _parse_memory_mi(
            self.container["resources"]["limits"]["memory"]
        )
        self.assertGreater(lim, 0)


class TestReadinessProbe(unittest.TestCase):
    """Validate the readinessProbe block added in this PR."""

    def setUp(self):
        self.container = _get_container(_load_manifest())

    def test_readiness_probe_is_present(self):
        self.assertIn("readinessProbe", self.container)

    def test_readiness_probe_uses_http_get(self):
        """readinessProbe must be an httpGet probe (not exec or tcpSocket)."""
        probe = self.container["readinessProbe"]
        self.assertIn(
            "httpGet",
            probe,
            msg="readinessProbe should use httpGet, not exec or tcpSocket",
        )
        self.assertNotIn("exec", probe)
        self.assertNotIn("tcpSocket", probe)

    def test_readiness_probe_path_is_actuator_health_readiness(self):
        path = self.container["readinessProbe"]["httpGet"]["path"]
        self.assertEqual(path, "/actuator/health/readiness")

    def test_readiness_probe_port_is_8080(self):
        port = self.container["readinessProbe"]["httpGet"]["port"]
        self.assertEqual(port, 8080)

    def test_readiness_probe_port_matches_container_port(self):
        """The probe port must target the declared container port."""
        probe_port = self.container["readinessProbe"]["httpGet"]["port"]
        declared_ports = [p["containerPort"] for p in self.container.get("ports", [])]
        self.assertIn(
            probe_port,
            declared_ports,
            msg=f"readinessProbe port {probe_port} not found in declared containerPorts {declared_ports}",
        )

    def test_readiness_probe_path_starts_with_slash(self):
        """All HTTP probe paths must be absolute (start with '/')."""
        path = self.container["readinessProbe"]["httpGet"]["path"]
        self.assertTrue(
            path.startswith("/"),
            msg=f"readinessProbe path '{path}' must start with '/'",
        )

    def test_readiness_probe_path_targets_actuator_namespace(self):
        """Path should be under Spring Boot Actuator's health namespace."""
        path = self.container["readinessProbe"]["httpGet"]["path"]
        self.assertTrue(
            path.startswith("/actuator/"),
            msg=f"Expected probe path under /actuator/, got '{path}'",
        )


class TestNoUnintendedSideEffects(unittest.TestCase):
    """Regression tests: PR should not have removed or changed pre-existing fields."""

    def setUp(self):
        self.manifest = _load_manifest()
        self.container = _get_container(self.manifest)

    def test_container_port_8080_still_declared(self):
        ports = [p["containerPort"] for p in self.container.get("ports", [])]
        self.assertIn(8080, ports)

    def test_image_pull_policy_is_still_always(self):
        self.assertEqual(self.container.get("imagePullPolicy"), "Always")

    def test_deployment_name_unchanged(self):
        self.assertEqual(self.manifest["metadata"]["name"], "product-service")

    def test_namespace_unchanged(self):
        self.assertEqual(self.manifest["metadata"]["namespace"], "backend-stg")

    def test_replica_count_unchanged(self):
        self.assertEqual(self.manifest["spec"]["replicas"], 1)

    def test_no_liveness_probe_added(self):
        """This PR only adds readinessProbe; livenessProbe was not in scope."""
        self.assertNotIn(
            "livenessProbe",
            self.container,
            msg="livenessProbe was not added in this PR and should not appear",
        )


if __name__ == "__main__":
    unittest.main()
