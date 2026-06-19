const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

class WorkspaceService {
  constructor() {
    this.baseDir = config.docker.workspaceBase;
    fs.ensureDirSync(this.baseDir);
  }

  createProject(projectName) {
    const projectId = uuidv4();
    const workspacePath = path.join(this.baseDir, projectId);

    fs.ensureDirSync(workspacePath);
    fs.ensureDirSync(path.join(workspacePath, 'pages'));
    fs.ensureDirSync(path.join(workspacePath, 'public'));
    fs.ensureDirSync(path.join(workspacePath, 'styles'));

    const metadata = {
      id: projectId,
      name: projectName,
      domain: `${projectName}.${config.domain}`,
      workspacePath,
      createdAt: new Date().toISOString(),
      status: 'created',
    };

    fs.writeJsonSync(path.join(workspacePath, '.sycord.json'), metadata, { spaces: 2 });
    return metadata;
  }

  writeProjectFiles(projectId, files) {
    const workspacePath = path.join(this.baseDir, projectId);

    if (!fs.existsSync(workspacePath)) {
      throw new Error(`Workspace ${projectId} not found`);
    }

    for (const file of files) {
      const filePath = path.join(workspacePath, file.path);
      fs.ensureDirSync(path.dirname(filePath));
      fs.writeFileSync(filePath, file.content, 'utf-8');
    }

    const metadataPath = path.join(workspacePath, '.sycord.json');
    const metadata = fs.readJsonSync(metadataPath);
    metadata.status = 'files_written';
    metadata.fileCount = files.length;
    metadata.updatedAt = new Date().toISOString();
    fs.writeJsonSync(metadataPath, metadata, { spaces: 2 });
  }

  async runBuild(projectId) {
    const workspacePath = path.join(this.baseDir, projectId);

    if (!fs.existsSync(workspacePath)) {
      throw new Error(`Workspace ${projectId} not found`);
    }

    const metadataPath = path.join(workspacePath, '.sycord.json');
    const metadata = fs.readJsonSync(metadataPath);
    metadata.status = 'building';
    metadata.buildStartedAt = new Date().toISOString();
    fs.writeJsonSync(metadataPath, metadata, { spaces: 2 });

    const hasPackageJson = fs.existsSync(path.join(workspacePath, 'package.json'));
    if (!hasPackageJson) {
      throw new Error('No package.json found in workspace');
    }

    try {
      execSync('npm install --production=false', {
        cwd: workspacePath,
        stdio: 'pipe',
        timeout: 300000,
        env: { ...process.env, NODE_ENV: 'development' },
      });

      execSync('npx next build', {
        cwd: workspacePath,
        stdio: 'pipe',
        timeout: 300000,
        env: { ...process.env, NODE_ENV: 'production' },
      });
    } catch (err) {
      metadata.status = 'build_failed';
      metadata.buildError = err.stderr?.toString() || err.message;
      fs.writeJsonSync(metadataPath, metadata, { spaces: 2 });
      throw new Error(`Build failed: ${metadata.buildError}`);
    }

    metadata.status = 'build_complete';
    metadata.buildCompletedAt = new Date().toISOString();
    fs.writeJsonSync(metadataPath, metadata, { spaces: 2 });

    return { success: true, workspacePath };
  }

  getProject(projectId) {
    const metadataPath = path.join(this.baseDir, projectId, '.sycord.json');
    if (!fs.existsSync(metadataPath)) return null;
    return fs.readJsonSync(metadataPath);
  }

  listProjects() {
    const dirs = fs.readdirSync(this.baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    return dirs.map(id => {
      const metadataPath = path.join(this.baseDir, id, '.sycord.json');
      if (fs.existsSync(metadataPath)) {
        try {
          return fs.readJsonSync(metadataPath);
        } catch {
          return null;
        }
      }
      return null;
    }).filter(Boolean);
  }

  deleteProject(projectId) {
    const workspacePath = path.join(this.baseDir, projectId);
    if (fs.existsSync(workspacePath)) {
      fs.removeSync(workspacePath);
    }
  }
}

module.exports = new WorkspaceService();
