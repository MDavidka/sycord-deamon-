const Docker = require('dockerode');
const path = require('path');
const fs = require('fs-extra');
const config = require('../config');

class DockerService {
  constructor() {
    this.docker = new Docker();
    this.network = config.docker.network;
    this.ports = new Map();
    this.init();
  }

  async init() {
    const networks = await this.docker.listNetworks({ filters: { name: [this.network] } });
    if (networks.length === 0) {
      await this.docker.createNetwork({ Name: this.network, Driver: 'bridge' });
    }
  }

  allocatePort(projectId) {
    const { start, end } = config.docker.portRange;
    const used = new Set(this.ports.values());
    for (let p = start; p <= end; p++) {
      if (!used.has(p)) {
        this.ports.set(projectId, p);
        return p;
      }
    }
    throw new Error('No available ports in range');
  }

  releasePort(projectId) {
    this.ports.delete(projectId);
  }

  async buildImage(projectId, workspacePath) {
    const dockerfilePath = path.resolve(__dirname, '..', 'docker', 'Dockerfile.nextjs');
    const imageName = `${config.docker.containerPrefix}${projectId}:latest`;

    const stream = await this.docker.buildImage(
      { context: workspacePath, src: ['.'] },
      { t: imageName, dockerfile: dockerfilePath }
    );

    await new Promise((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);
        resolve(output);
      });
    });

    return imageName;
  }

  async createContainer(projectId, projectName, imageName, workspacePath) {
    const containerName = `${config.docker.containerPrefix}${projectName}`;
    const port = this.allocatePort(projectId);

    const container = await this.docker.createContainer({
      name: containerName,
      Image: imageName,
      Env: [
        `NODE_ENV=production`,
        `PORT=3000`,
      ],
      ExposedPorts: { '3000/tcp': {} },
      HostConfig: {
        PortBindings: { '3000/tcp': [{ HostPort: String(port) }] },
        Binds: [
          `${workspacePath}:/app`,
          `${workspacePath}/node_modules:/app/node_modules`,
          `${workspacePath}/.next:/app/.next`,
        ],
        NetworkMode: this.network,
        RestartPolicy: { Name: 'always' },
      },
    });

    await container.start();
    return { container, port };
  }

  async stopContainer(projectName) {
    const containerName = `${config.docker.containerPrefix}${projectName}`;
    try {
      const container = this.docker.getContainer(containerName);
      await container.stop().catch(() => {});
      await container.remove({ force: true }).catch(() => {});
      return true;
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw err;
    }
  }

  async getContainerStatus(projectName) {
    const containerName = `${config.docker.containerPrefix}${projectName}`;
    try {
      const container = this.docker.getContainer(containerName);
      const info = await container.inspect();
      return {
        running: info.State.Running,
        status: info.State.Status,
        startedAt: info.State.StartedAt,
        ports: info.NetworkSettings?.Ports,
      };
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  async getLogs(projectName, tail = 100) {
    const containerName = `${config.docker.containerPrefix}${projectName}`;
    try {
      const container = this.docker.getContainer(containerName);
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail,
        timestamps: true,
      });
      return logs.toString('utf-8');
    } catch (err) {
      if (err.statusCode === 404) return null;
      throw err;
    }
  }

  async listContainers() {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { name: [config.docker.containerPrefix] },
    });

    return containers.map(c => ({
      id: c.Id.substring(0, 12),
      name: c.Names[0]?.replace('/', ''),
      projectName: c.Names[0]?.replace('/', '').replace(config.docker.containerPrefix, ''),
      state: c.State,
      status: c.Status,
      ports: c.Ports,
    }));
  }
}

module.exports = new DockerService();
