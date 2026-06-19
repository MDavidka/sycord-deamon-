const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const dockerService = require('../services/docker');
const workspaceService = require('../utils/workspace');

// GET /api/deploy/projects - List all projects
router.get('/projects', async (req, res) => {
  try {
    const projects = workspaceService.listProjects();
    const containers = await dockerService.listContainers();

    const merged = projects.map(p => {
      const container = containers.find(c => c.projectName === p.name);
      return { ...p, container: container || null };
    });

    res.json({ projects: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deploy/projects - Create a new project
router.post('/projects', async (req, res) => {
  try {
    const { projectName } = req.body;

    if (!projectName || !/^[a-z0-9-]+$/.test(projectName)) {
      return res.status(400).json({
        error: 'projectName is required and must be lowercase alphanumeric with hyphens only',
      });
    }

    const metadata = workspaceService.createProject(projectName);

    res.status(201).json({
      message: 'Project workspace created',
      project: metadata,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/deploy/projects/:projectId/files - Write source files
router.put('/projects/:projectId/files', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { files } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required' });
    }

    const project = workspaceService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    workspaceService.writeProjectFiles(projectId, files);

    res.json({
      message: 'Files written successfully',
      project: workspaceService.getProject(projectId),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deploy/projects/:projectId/build - Trigger build
router.post('/projects/:projectId/build', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = workspaceService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const result = await workspaceService.runBuild(projectId);

    res.json({
      message: 'Build completed successfully',
      project: workspaceService.getProject(projectId),
      result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deploy/projects/:projectId/deploy - Deploy to Docker container
router.post('/projects/:projectId/deploy', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = workspaceService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.status !== 'build_complete') {
      return res.status(400).json({
        error: `Project must be built before deploying. Current status: ${project.status}`,
      });
    }

    const imageName = await dockerService.buildImage(projectId, project.workspacePath);
    const { container, port } = await dockerService.createContainer(
      projectId,
      project.name,
      imageName,
      project.workspacePath
    );

    project.status = 'deployed';
    project.containerPort = port;
    project.imageName = imageName;
    project.containerId = container.id;
    project.deployedAt = new Date().toISOString();
    await fs.writeJson(
      path.join(project.workspacePath, '.sycord.json'),
      project,
      { spaces: 2 }
    );

    req.app.registerDeployPort(project.name, port);

    res.json({
      message: 'Deployment complete',
      project,
      url: `https://${project.domain}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deploy/projects/:projectId/stop - Stop container
router.post('/projects/:projectId/stop', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = workspaceService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const stopped = await dockerService.stopContainer(project.name);
    dockerService.releasePort(projectId);
    if (project.containerPort) {
      req.app.deregisterDeployPort(project.containerPort);
    }

    project.status = 'stopped';
    project.stoppedAt = new Date().toISOString();
    await fs.writeJson(
      path.join(project.workspacePath, '.sycord.json'),
      project,
      { spaces: 2 }
    );

    res.json({ message: stopped ? 'Container stopped' : 'No container was running', project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/deploy/projects/:projectId - Delete project and container
router.delete('/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = workspaceService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    await dockerService.stopContainer(project.name).catch(() => {});
    dockerService.releasePort(projectId);
    workspaceService.deleteProject(projectId);

    res.json({ message: 'Project deleted', projectName: project.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deploy/projects/:projectId/logs - Get container logs
router.get('/projects/:projectId/logs', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { tail } = req.query;

    const project = workspaceService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const logs = await dockerService.getLogs(project.name, parseInt(tail) || 100);

    if (logs === null) {
      return res.status(404).json({ error: 'No container found' });
    }

    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deploy/projects/:projectId/status - Get container status
router.get('/projects/:projectId/status', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = workspaceService.getProject(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const status = await dockerService.getContainerStatus(project.name);

    res.json({
      project,
      containerStatus: status,
      url: project.status === 'deployed' ? `https://${project.domain}` : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
