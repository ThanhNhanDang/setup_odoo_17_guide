"""
Tests for setup.py - Odoo 17 Installer
Run: python -m pytest test_setup.py -v
  or: python test_setup.py
"""

import configparser
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch, MagicMock

# Import the module under test
import setup


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _create_fake_project(projects_dir, name, http_port="8069"):
    """Create a minimal project folder with odoo.conf for testing."""
    proj = os.path.join(projects_dir, name)
    os.makedirs(proj, exist_ok=True)
    os.makedirs(os.path.join(proj, "addons"), exist_ok=True)
    conf_content = "[options]\nhttp_port = {}\ndb_host = localhost\ndb_port = 5432\n".format(http_port)
    with open(os.path.join(proj, "odoo.conf"), "w", encoding="utf-8") as f:
        f.write(conf_content)
    return proj


class TempDirMixin:
    """Mixin that creates and cleans up temp directories for each test."""

    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="odoo_test_")
        self.base_dir = os.path.join(self.test_dir, "odoo_17_base")
        self.projects_dir = os.path.join(self.test_dir, "projects")
        os.makedirs(self.base_dir, exist_ok=True)
        os.makedirs(self.projects_dir, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)


# ===========================================================================
# 1. Detection Functions
# ===========================================================================
class TestFindPython311(unittest.TestCase):
    """Test Python 3.11 detection logic."""

    def test_returns_path_when_python311_exists(self):
        """Should return path string when Python 3.11 is found."""
        result = setup.find_python311()
        # On the dev machine it may or may not exist
        if result is not None:
            self.assertTrue(result.endswith("python.exe"))
            self.assertIn("311", result)

    @patch("os.path.isfile", return_value=False)
    def test_returns_none_when_not_found(self, mock_isfile):
        """Should return None when no Python 3.11 is installed."""
        result = setup.find_python311()
        self.assertIsNone(result)


class TestFindPostgresBin(unittest.TestCase):
    """Test PostgreSQL binary detection."""

    @patch("os.path.isfile", return_value=False)
    def test_returns_none_when_not_installed(self, mock_isfile):
        """Should return None when PostgreSQL is not installed."""
        result = setup.find_postgres_bin()
        self.assertIsNone(result)


class TestFindDocker(unittest.TestCase):
    """Test Docker availability detection."""

    @patch("subprocess.run")
    def test_returns_true_when_docker_available(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        self.assertTrue(setup.find_docker())

    @patch("subprocess.run", side_effect=FileNotFoundError)
    def test_returns_false_when_docker_not_installed(self, mock_run):
        self.assertFalse(setup.find_docker())

    @patch("subprocess.run")
    def test_returns_false_when_docker_fails(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1)
        self.assertFalse(setup.find_docker())


class TestFindDockerPostgres(unittest.TestCase):
    """Test Docker PostgreSQL container detection."""

    @patch("subprocess.run")
    def test_parses_running_postgres_container(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="odoo-pg\tpostgres:16\t0.0.0.0:5432->5432/tcp\tUp 2 hours\n"
        )
        result = setup.find_docker_postgres()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "odoo-pg")
        self.assertEqual(result[0]["port"], "5432")
        self.assertIn("postgres", result[0]["image"])

    @patch("subprocess.run")
    def test_returns_empty_when_no_containers(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        result = setup.find_docker_postgres()
        self.assertEqual(result, [])

    @patch("subprocess.run", side_effect=Exception("docker not found"))
    def test_returns_empty_on_error(self, mock_run):
        result = setup.find_docker_postgres()
        self.assertEqual(result, [])

    @patch("subprocess.run")
    def test_ignores_non_postgres_containers(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="redis-cache\tredis:7\t0.0.0.0:6379->6379/tcp\tUp 1 hour\n"
        )
        result = setup.find_docker_postgres()
        self.assertEqual(result, [])


# ===========================================================================
# 2. Project Config Parsing
# ===========================================================================
class TestParseProjectConfig(TempDirMixin, unittest.TestCase):
    """Test project config parsing from odoo.conf."""

    def test_parse_valid_config(self):
        proj = _create_fake_project(self.projects_dir, "test_proj", "8080")
        result = setup.parse_project_config(proj, self.base_dir)
        self.assertEqual(result["name"], "test_proj")
        self.assertEqual(result["http_port"], "8080")
        self.assertEqual(result["db_host"], "localhost")

    def test_parse_missing_config(self):
        proj = os.path.join(self.projects_dir, "no_conf")
        os.makedirs(proj, exist_ok=True)
        result = setup.parse_project_config(proj, self.base_dir)
        self.assertEqual(result["name"], "no_conf")
        self.assertEqual(result["http_port"], "")

    def test_parse_empty_dir(self):
        proj = os.path.join(self.projects_dir, "empty")
        os.makedirs(proj, exist_ok=True)
        result = setup.parse_project_config(proj, self.base_dir)
        self.assertEqual(result["name"], "empty")
        self.assertEqual(result["custom_modules"], 0)

    def test_counts_custom_modules(self):
        proj = _create_fake_project(self.projects_dir, "mod_test")
        # Update config with addons_path pointing to ./addons
        conf_path = os.path.join(proj, "odoo.conf")
        with open(conf_path, "w", encoding="utf-8") as f:
            f.write("[options]\nhttp_port = 8069\naddons_path = ./addons\n")
        # Create fake addon modules
        for mod_name in ["module_a", "module_b"]:
            mod_dir = os.path.join(proj, "addons", mod_name)
            os.makedirs(mod_dir, exist_ok=True)
            with open(os.path.join(mod_dir, "__manifest__.py"), "w") as f:
                f.write("{}")
        result = setup.parse_project_config(proj, self.base_dir)
        self.assertEqual(result["custom_modules"], 2)


# ===========================================================================
# 3. Project Management (CRUD)
# ===========================================================================
class TestReadProjectConfig(TempDirMixin, unittest.TestCase):
    """Test reading project odoo.conf."""

    def test_read_existing_config(self):
        _create_fake_project(self.projects_dir, "proj_read")
        result = setup.read_project_config(self.projects_dir, "proj_read")
        self.assertTrue(result["ok"])
        self.assertIn("[options]", result["content"])

    def test_read_missing_project(self):
        result = setup.read_project_config(self.projects_dir, "nonexistent")
        self.assertFalse(result["ok"])
        self.assertIn("not found", result["msg"].lower())


class TestSaveProjectConfig(TempDirMixin, unittest.TestCase):
    """Test saving project odoo.conf."""

    def test_save_valid_config(self):
        _create_fake_project(self.projects_dir, "proj_save")
        new_content = "[options]\nhttp_port = 9999\ndb_host = 127.0.0.1\n"
        result = setup.save_project_config(self.projects_dir, "proj_save", new_content)
        self.assertTrue(result["ok"])
        # Verify written content
        conf = os.path.join(self.projects_dir, "proj_save", "odoo.conf")
        with open(conf, "r", encoding="utf-8") as f:
            self.assertEqual(f.read(), new_content)

    def test_save_invalid_config_format(self):
        _create_fake_project(self.projects_dir, "proj_invalid")
        result = setup.save_project_config(self.projects_dir, "proj_invalid", "not a valid ini")
        # configparser may or may not reject this - depends on content
        # But a truly invalid format should fail
        bad_content = "[options\nbroken"
        result = setup.save_project_config(self.projects_dir, "proj_invalid", bad_content)
        self.assertFalse(result["ok"])
        self.assertIn("Invalid config", result["msg"])

    def test_save_missing_project(self):
        result = setup.save_project_config(self.projects_dir, "ghost", "[options]\nhttp_port=1\n")
        self.assertFalse(result["ok"])


class TestDeleteProject(TempDirMixin, unittest.TestCase):
    """Test project deletion."""

    def test_delete_existing_project(self):
        proj = _create_fake_project(self.projects_dir, "to_delete")
        self.assertTrue(os.path.isdir(proj))
        result = setup.delete_project(self.projects_dir, "to_delete")
        self.assertTrue(result["ok"])
        self.assertFalse(os.path.exists(proj))

    def test_delete_nonexistent_project(self):
        result = setup.delete_project(self.projects_dir, "no_such")
        self.assertFalse(result["ok"])

    def test_delete_dir_without_config(self):
        """A directory without odoo.conf should not be deletable as a project."""
        proj = os.path.join(self.projects_dir, "no_conf")
        os.makedirs(proj, exist_ok=True)
        result = setup.delete_project(self.projects_dir, "no_conf")
        self.assertFalse(result["ok"])


class TestDuplicateProject(TempDirMixin, unittest.TestCase):
    """Test project duplication."""

    def test_duplicate_project(self):
        _create_fake_project(self.projects_dir, "original", "8069")
        result = setup.duplicate_project(
            self.base_dir, self.projects_dir, "original", "copy_proj", "8080")
        self.assertTrue(result["ok"])
        # Verify new project exists with updated port
        new_conf = os.path.join(self.projects_dir, "copy_proj", "odoo.conf")
        self.assertTrue(os.path.isfile(new_conf))
        cp = configparser.RawConfigParser()
        cp.read(new_conf, encoding="utf-8")
        self.assertEqual(cp.get("options", "http_port"), "8080")

    def test_duplicate_nonexistent_source(self):
        result = setup.duplicate_project(
            self.base_dir, self.projects_dir, "ghost", "copy", "8080")
        self.assertFalse(result["ok"])

    def test_duplicate_to_existing_name(self):
        _create_fake_project(self.projects_dir, "src_proj")
        _create_fake_project(self.projects_dir, "dst_proj")
        result = setup.duplicate_project(
            self.base_dir, self.projects_dir, "src_proj", "dst_proj", "8080")
        self.assertFalse(result["ok"])
        self.assertIn("already exists", result["msg"])

    def test_duplicate_sets_longpolling_port(self):
        _create_fake_project(self.projects_dir, "lp_test", "8069")
        setup.duplicate_project(
            self.base_dir, self.projects_dir, "lp_test", "lp_copy", "9000")
        new_conf = os.path.join(self.projects_dir, "lp_copy", "odoo.conf")
        cp = configparser.RawConfigParser()
        cp.read(new_conf, encoding="utf-8")
        self.assertEqual(cp.get("options", "longpolling_port"), "9003")


# ===========================================================================
# 4. Installation Steps (mocked - no real installs)
# ===========================================================================
class TestStepInstallPython(unittest.TestCase):
    """Test Python installation step."""

    @patch.object(setup, "find_python311", return_value=r"C:\Python311\python.exe")
    def test_skips_when_already_installed(self, mock_find):
        result = setup.step_install_python("C:\\temp")
        self.assertTrue(result["ok"])
        self.assertIn("Already", result["msg"])

    @patch.object(setup, "find_python311", side_effect=[None, None])
    @patch("urllib.request.urlretrieve", side_effect=Exception("network error"))
    def test_fails_on_download_error(self, mock_download, mock_find):
        result = setup.step_install_python("C:\\temp")
        self.assertFalse(result["ok"])
        self.assertIn("Download failed", result["msg"])


class TestStepCloneOdoo(TempDirMixin, unittest.TestCase):
    """Test Odoo clone step."""

    def test_skips_when_already_cloned(self):
        odoo_dir = os.path.join(self.base_dir, "odoo")
        os.makedirs(odoo_dir, exist_ok=True)
        with open(os.path.join(odoo_dir, "odoo-bin"), "w") as f:
            f.write("#!/usr/bin/env python3")
        result = setup.step_clone_odoo(self.base_dir)
        self.assertTrue(result["ok"])
        self.assertIn("Already", result["msg"])


class TestStepCreateVenv(TempDirMixin, unittest.TestCase):
    """Test venv creation step."""

    @patch.object(setup, "find_python311", return_value=None)
    def test_fails_when_no_python(self, mock_find):
        result = setup.step_create_venv(self.base_dir)
        self.assertFalse(result["ok"])
        self.assertIn("not found", result["msg"])

    def test_skips_when_venv_exists_with_311(self):
        venv_scripts = os.path.join(self.base_dir, "venv", "Scripts")
        os.makedirs(venv_scripts, exist_ok=True)
        python_exe = os.path.join(venv_scripts, "python.exe")
        with open(python_exe, "w") as f:
            f.write("fake")
        with patch.object(setup, "run_cmd", return_value=(0, "Python 3.11.4")):
            result = setup.step_create_venv(self.base_dir)
            self.assertTrue(result["ok"])


class TestStepInstallRequirements(TempDirMixin, unittest.TestCase):
    """Test pip requirements installation step."""

    def test_fails_when_no_venv(self):
        result = setup.step_install_requirements(self.base_dir)
        self.assertFalse(result["ok"])
        self.assertIn("Venv not found", result["msg"])

    def test_fails_when_no_requirements_txt(self):
        pip_path = os.path.join(self.base_dir, "venv", "Scripts")
        os.makedirs(pip_path, exist_ok=True)
        with open(os.path.join(pip_path, "pip.exe"), "w") as f:
            f.write("fake")
        result = setup.step_install_requirements(self.base_dir)
        self.assertFalse(result["ok"])
        self.assertIn("requirements.txt", result["msg"])


class TestStepCreateProject(TempDirMixin, unittest.TestCase):
    """Test project creation step."""

    def test_fails_with_empty_name(self):
        result = setup.step_create_project(self.base_dir, self.projects_dir, "")
        self.assertFalse(result["ok"])
        self.assertIn("required", result["msg"])

    def test_fails_when_project_exists(self):
        _create_fake_project(self.projects_dir, "existing")
        result = setup.step_create_project(self.base_dir, self.projects_dir, "existing")
        self.assertFalse(result["ok"])
        self.assertIn("already exists", result["msg"])


# ===========================================================================
# 5. Status Detection
# ===========================================================================
class TestDetectStatus(TempDirMixin, unittest.TestCase):
    """Test overall status detection."""

    @patch.object(setup, "find_python311", return_value=None)
    @patch.object(setup, "find_postgres_bin", return_value=None)
    @patch.object(setup, "find_docker", return_value=False)
    @patch.object(setup, "detect_native_postgres_details", return_value=None)
    def test_detect_clean_system(self, *mocks):
        status = setup.detect_status(self.base_dir, self.projects_dir)
        self.assertFalse(status["python311"])
        self.assertFalse(status["postgres"])
        self.assertFalse(status["odoo_cloned"])
        self.assertFalse(status["venv_created"])
        self.assertFalse(status["requirements_installed"])
        self.assertEqual(status["projects"], [])

    @patch.object(setup, "find_python311", return_value=r"C:\Python311\python.exe")
    @patch.object(setup, "find_postgres_bin", return_value=r"C:\PostgreSQL\16\bin")
    @patch.object(setup, "find_docker", return_value=False)
    @patch.object(setup, "detect_native_postgres_details", return_value={"bin_path": "test"})
    def test_detect_with_components(self, *mocks):
        status = setup.detect_status(self.base_dir, self.projects_dir)
        self.assertTrue(status["python311"])
        self.assertTrue(status["postgres"])

    @patch.object(setup, "find_python311", return_value=None)
    @patch.object(setup, "find_postgres_bin", return_value=None)
    @patch.object(setup, "find_docker", return_value=False)
    @patch.object(setup, "detect_native_postgres_details", return_value=None)
    def test_lists_projects(self, *mocks):
        _create_fake_project(self.projects_dir, "proj_a", "8069")
        _create_fake_project(self.projects_dir, "proj_b", "8070")
        status = setup.detect_status(self.base_dir, self.projects_dir)
        names = [p["name"] for p in status["projects"]]
        self.assertIn("proj_a", names)
        self.assertIn("proj_b", names)
        self.assertEqual(len(status["projects"]), 2)


# ===========================================================================
# 6. HTTP API (Integration Tests)
# ===========================================================================
class TestHTTPApi(TempDirMixin, unittest.TestCase):
    """Test HTTP API endpoints with a real server."""

    @classmethod
    def setUpClass(cls):
        """Start test server on a random port."""
        cls.test_tmpdir = tempfile.mkdtemp(prefix="odoo_api_test_")
        cls.test_base = os.path.join(cls.test_tmpdir, "base")
        cls.test_projects = os.path.join(cls.test_tmpdir, "projects")
        os.makedirs(cls.test_base, exist_ok=True)
        os.makedirs(cls.test_projects, exist_ok=True)

        cls.server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), setup.InstallerHandler)
        cls.port = cls.server.server_address[1]
        cls.base_url = "http://127.0.0.1:{}".format(cls.port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        shutil.rmtree(cls.test_tmpdir, ignore_errors=True)

    def _post(self, path, data=None, timeout=60):
        body = data or {}
        body.setdefault("base_dir", self.test_base)
        body.setdefault("projects_dir", self.test_projects)
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _get(self, path):
        req = urllib.request.Request(self.base_url + path)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8")

    # --- GET ---
    def test_get_index_returns_html(self):
        status, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn("<!DOCTYPE html>", body)

    def test_get_unknown_returns_404(self):
        try:
            self._get("/nonexistent")
            self.fail("Expected 404")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)

    # --- /api/status ---
    def test_api_status_returns_valid_json(self):
        result = self._post("/api/status")
        self.assertIn("python311", result)
        self.assertIn("postgres", result)
        self.assertIn("projects", result)
        self.assertIsInstance(result["projects"], list)

    # --- /api/log ---
    def test_api_log_returns_lines_and_task(self):
        result = self._post("/api/log")
        self.assertIn("lines", result)
        self.assertIn("task", result)
        self.assertIsInstance(result["lines"], list)

    # --- /api/create_project ---
    def test_api_create_project_empty_name(self):
        result = self._post("/api/create_project", {"project_name": ""})
        self.assertFalse(result["ok"])

    def test_api_create_project_duplicate(self):
        _create_fake_project(self.test_projects, "dup_test")
        result = self._post("/api/create_project", {"project_name": "dup_test"})
        self.assertFalse(result["ok"])
        self.assertIn("already exists", result["msg"])

    # --- /api/read_config ---
    def test_api_read_config_existing(self):
        _create_fake_project(self.test_projects, "read_api_test")
        result = self._post("/api/read_config", {"project_name": "read_api_test"})
        self.assertTrue(result["ok"])
        self.assertIn("[options]", result["content"])

    def test_api_read_config_missing(self):
        result = self._post("/api/read_config", {"project_name": "nope"})
        self.assertFalse(result["ok"])

    # --- /api/save_config ---
    def test_api_save_config(self):
        _create_fake_project(self.test_projects, "save_api_test")
        new_conf = "[options]\nhttp_port = 7777\n"
        result = self._post("/api/save_config", {
            "project_name": "save_api_test", "content": new_conf})
        self.assertTrue(result["ok"])
        # Verify
        read_result = self._post("/api/read_config", {"project_name": "save_api_test"})
        self.assertIn("7777", read_result["content"])

    # --- /api/delete_project ---
    def test_api_delete_project(self):
        _create_fake_project(self.test_projects, "del_api_test")
        result = self._post("/api/delete_project", {"project_name": "del_api_test"})
        self.assertTrue(result["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.test_projects, "del_api_test")))

    # --- /api/duplicate_project ---
    def test_api_duplicate_project(self):
        _create_fake_project(self.test_projects, "dup_src")
        result = self._post("/api/duplicate_project", {
            "project_name": "dup_src", "new_name": "dup_dst", "new_http_port": "9090"})
        self.assertTrue(result["ok"])

    # --- /api/run_step unknown ---
    def test_api_run_step_unknown(self):
        result = self._post("/api/run_step", {"step": "nonexistent_step"})
        self.assertFalse(result["ok"])

    # --- /api/full_install (regression test for multiple values bug) ---
    @patch.object(setup, "step_full_install", return_value=[{"step": "test", "ok": True, "msg": "ok"}])
    def test_api_full_install_no_multiple_values_error(self, mock_install):
        """Regression: /api/full_install should not crash with 'multiple values for argument'."""
        # Reset task status for this test
        setup.current_task["status"] = "idle"
        result = self._post("/api/full_install", {
            "project_name": "regression_test",
            "db_port": "5432",
        })
        self.assertTrue(result["ok"])
        self.assertIn("msg", result)
        # Wait for background thread to call step_full_install
        import time
        time.sleep(0.5)
        mock_install.assert_called_once()
        # Reset for other tests
        setup.current_task["status"] = "idle"

    # --- 404 for unknown API ---
    def test_api_unknown_endpoint(self):
        try:
            self._post("/api/doesnotexist")
            self.fail("Expected 404")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)


# ===========================================================================
# 7. Utility Functions
# ===========================================================================
class TestLogFunction(unittest.TestCase):
    """Test the log utility."""

    def test_log_appends_to_log_lines(self):
        initial_count = len(setup.log_lines)
        setup.log("test message")
        self.assertEqual(len(setup.log_lines), initial_count + 1)
        self.assertIn("test message", setup.log_lines[-1])

    def test_log_includes_timestamp(self):
        setup.log("timestamp check")
        # Format: [HH:MM:SS] message
        self.assertRegex(setup.log_lines[-1], r"\[\d{2}:\d{2}:\d{2}\]")


class TestRunCmd(unittest.TestCase):
    """Test command runner."""

    def test_successful_command(self):
        code, output = setup.run_cmd("echo hello")
        self.assertEqual(code, 0)
        self.assertIn("hello", output)

    def test_failing_command(self):
        code, output = setup.run_cmd("exit 1")
        self.assertEqual(code, 1)


# ===========================================================================
# 8. Template Files
# ===========================================================================
class TestTemplates(unittest.TestCase):
    """Test that template files exist and are valid."""

    def test_odoo_conf_template_exists(self):
        template = setup.TEMPLATES_DIR / "odoo.conf"
        self.assertTrue(template.exists())

    def test_launch_json_template_exists(self):
        template = setup.TEMPLATES_DIR / "launch.json"
        self.assertTrue(template.exists())

    def test_odoo_conf_template_has_placeholders(self):
        content = (setup.TEMPLATES_DIR / "odoo.conf").read_text(encoding="utf-8")
        self.assertIn("{http_port}", content)
        self.assertIn("{db_host}", content)
        self.assertIn("{addons_path}", content)

    def test_launch_json_template_has_placeholders(self):
        content = (setup.TEMPLATES_DIR / "launch.json").read_text(encoding="utf-8")
        self.assertIn("{python_path}", content)
        self.assertIn("{odoo_bin_path}", content)

    def test_odoo_conf_template_renders(self):
        """Template should render without error using PROJECT_DEFAULTS."""
        content = (setup.TEMPLATES_DIR / "odoo.conf").read_text(encoding="utf-8")
        rendered = content.format(**setup.PROJECT_DEFAULTS)
        self.assertIn("http_port", rendered)
        self.assertNotIn("{http_port}", rendered)


# ===========================================================================
# Entry point
# ===========================================================================
if __name__ == "__main__":
    unittest.main(verbosity=2)
