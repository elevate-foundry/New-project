import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, access, constants } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, normalize } from 'node:path';
import { AppError, assert } from './errors.js';

const execAsync = promisify(exec);

export class ToolHarness {
  constructor({ audit, auth, permissions, logger = console } = {}) {
    this.audit = audit;
    this.auth = auth;
    this.permissions = permissions;
    this.logger = logger;
    this.tools = new Map();
    this.executionHistory = [];
    this.maxHistorySize = 1000;
    
    this.registerDefaultPrimitives();
  }

  registerDefaultPrimitives() {
    this.registerTool({
      name: 'create',
      description: 'Create a new resource (file, directory, record)',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['file', 'directory', 'record'], description: 'Resource type to create' },
          path: { type: 'string', description: 'Path or identifier for the resource' },
          content: { type: 'string', description: 'Content for file or record (optional)' },
          metadata: { type: 'object', description: 'Additional metadata (optional)' }
        },
        required: ['type', 'path']
      },
      handler: this.handleCreate.bind(this),
      permissions: ['tools:create'],
      reversible: true
    });

    this.registerTool({
      name: 'exec',
      description: 'Execute a command or operation',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command or operation to execute' },
          args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
          cwd: { type: 'string', description: 'Working directory (optional)' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' }
        },
        required: ['command']
      },
      handler: this.handleExec.bind(this),
      permissions: ['tools:exec'],
      reversible: false,
      dangerous: true
    });

    this.registerTool({
      name: 'read',
      description: 'Read a resource (file, record, state)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path or identifier to read' },
          format: { type: 'string', enum: ['text', 'json', 'binary'], description: 'Output format (default: text)' }
        },
        required: ['path']
      },
      handler: this.handleRead.bind(this),
      permissions: ['tools:read'],
      reversible: false
    });

    this.registerTool({
      name: 'help',
      description: 'List available tools or get help for a specific tool',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Tool name to get help for (optional)' }
        }
      },
      handler: this.handleHelp.bind(this),
      permissions: ['tools:help'],
      reversible: false
    });
  }

  registerTool(tool) {
    assert(tool.name, 400, 'invalid_tool', 'Tool must have a name');
    assert(tool.handler, 400, 'invalid_tool', 'Tool must have a handler');
    assert(tool.permissions, 400, 'invalid_tool', 'Tool must have permissions');
    
    this.tools.set(tool.name, {
      id: randomUUID(),
      ...tool,
      registeredAt: new Date().toISOString()
    });
    
    this.logger.log(`[ToolHarness] Registered tool: ${tool.name}`);
  }

  listTools() {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      dangerous: tool.dangerous ?? false,
      reversible: tool.reversible ?? false,
      requiredPermissions: tool.permissions
    }));
  }

  getTool(name) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new AppError(404, 'tool_not_found', `Tool '${name}' not found`);
    }
    return tool;
  }

  async execute({ toolName, parameters, actor, requestId }) {
    const tool = this.getTool(toolName);
    
    // Validate parameters
    this.validateParameters(tool, parameters);
    
    // Check permissions using PermissionService if available, otherwise fallback to AuthService
    if (actor?.session) {
      if (this.permissions) {
        const permissionResult = await this.permissions.checkToolPermission({
          session: actor.session,
          toolName,
          toolPermissions: tool.permissions,
          resourceContext: parameters.resourceContext ?? {}
        });
        
        if (!permissionResult.allowed) {
          throw new AppError(403, 'permission_denied', permissionResult.reason);
        }
      } else {
        this.auth.checkPermissions(actor.session, tool.permissions);
      }
    }
    
    const executionId = randomUUID();
    const startedAt = new Date().toISOString();
    const started = performance.now();
    
    // Log execution start
    this.logger.log(`[ToolHarness] Executing ${toolName}: ${JSON.stringify(parameters)}`);
    
    try {
      // Execute the tool
      const result = await tool.handler(parameters, { actor, requestId, tool });
      
      const completedAt = new Date().toISOString();
      const latencyMs = Math.round(performance.now() - started);
      
      const execution = {
        id: executionId,
        requestId,
        toolName,
        parameters,
        result,
        actor: actor ? { bbid: actor.bbid, userId: actor.userId } : null,
        startedAt,
        completedAt,
        latencyMs,
        status: 'success'
      };
      
      // Add to history
      this.addToHistory(execution);
      
      // Audit log
      if (this.audit) {
        await this.audit.append({
          type: 'tool.executed',
          actor: actor ?? {},
          summary: `Executed tool ${toolName}`,
          metadata: {
            executionId,
            toolName,
            parameters,
            latencyMs,
            result: this.sanitizeResult(result)
          }
        });
      }
      
      return execution;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const latencyMs = Math.round(performance.now() - started);
      
      const execution = {
        id: executionId,
        requestId,
        toolName,
        parameters,
        result: null,
        error: error.message,
        actor: actor ? { bbid: actor.bbid, userId: actor.userId } : null,
        startedAt,
        completedAt,
        latencyMs,
        status: 'error'
      };
      
      this.addToHistory(execution);
      
      if (this.audit) {
        await this.audit.append({
          type: 'tool.failed',
          actor: actor ?? {},
          summary: `Tool ${toolName} failed: ${error.message}`,
          metadata: {
            executionId,
            toolName,
            parameters,
            error: error.message
          }
        });
      }
      
      throw error;
    }
  }

  validateParameters(tool, parameters) {
    if (!tool.parameters) return;
    
    const schema = tool.parameters;
    const params = parameters ?? {};
    
    if (schema.required) {
      for (const required of schema.required) {
        if (!(required in params)) {
          throw new AppError(400, 'missing_parameter', `Missing required parameter: ${required}`);
        }
      }
    }
    
    // Type validation for known properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in params) {
          const value = params[key];
          if (propSchema.type === 'string' && typeof value !== 'string') {
            throw new AppError(400, 'invalid_parameter', `Parameter ${key} must be a string`);
          }
          if (propSchema.type === 'number' && typeof value !== 'number') {
            throw new AppError(400, 'invalid_parameter', `Parameter ${key} must be a number`);
          }
          if (propSchema.type === 'array' && !Array.isArray(value)) {
            throw new AppError(400, 'invalid_parameter', `Parameter ${key} must be an array`);
          }
          if (propSchema.enum && !propSchema.enum.includes(value)) {
            throw new AppError(400, 'invalid_parameter', `Parameter ${key} must be one of: ${propSchema.enum.join(', ')}`);
          }
        }
      }
    }
  }

  addToHistory(execution) {
    this.executionHistory.push(execution);
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory.shift();
    }
  }

  getHistory({ limit = 50, toolName, actor } = {}) {
    let filtered = this.executionHistory;
    
    if (toolName) {
      filtered = filtered.filter(e => e.toolName === toolName);
    }
    
    if (actor?.bbid) {
      filtered = filtered.filter(e => e.actor?.bbid === actor.bbid);
    }
    
    return filtered.slice(-limit);
  }

  sanitizeResult(result) {
    // Remove sensitive data from audit logs
    if (typeof result !== 'object' || result === null) {
      return result;
    }
    
    const sanitized = { ...result };
    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'privateKey'];
    
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        sanitized[key] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  // Default tool handlers

  async handleCreate(parameters, context) {
    const { type, path, content, metadata } = parameters;
    
    // Resolve and normalize the path
    const cwd = process.cwd();
    const resolvedPath = path.startsWith('/') ? resolve(path) : join(cwd, path);
    const normalizedPath = normalize(resolvedPath);
    
    this.logger.log(`[ToolHarness] Creating ${type} at ${normalizedPath} (cwd: ${cwd}, original: ${path})`);
    
    // Security: prevent path traversal outside working directory
    if (!normalizedPath.startsWith(cwd)) {
      throw new AppError(403, 'path_forbidden', 'Cannot create resources outside working directory');
    }
    
    if (type === 'file') {
      await writeFile(normalizedPath, content ?? '', 'utf8');
      const stats = await stat(normalizedPath);
      this.logger.log(`[ToolHarness] File created: ${normalizedPath}, size: ${stats.size}`);
      return {
        success: true,
        type: 'file',
        path: normalizedPath,
        size: stats.size,
        createdAt: stats.mtime.toISOString(),
        message: `File created at ${normalizedPath}`
      };
    }
    
    if (type === 'directory') {
      await mkdir(normalizedPath, { recursive: true });
      const stats = await stat(normalizedPath);
      return {
        success: true,
        type: 'directory',
        path: normalizedPath,
        createdAt: stats.mtime.toISOString(),
        message: `Directory created at ${normalizedPath}`
      };
    }
    
    if (type === 'record') {
      // For records, we'll store them in a data directory
      const dataDir = join(cwd, 'data', 'records');
      if (!existsSync(dataDir)) {
        await mkdir(dataDir, { recursive: true });
      }
      const recordPath = join(dataDir, `${path}.json`);
      const record = {
        id: path,
        metadata: metadata ?? {},
        createdAt: new Date().toISOString()
      };
      await writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8');
      return {
        success: true,
        type: 'record',
        id: path,
        path: recordPath,
        metadata: metadata ?? {},
        createdAt: record.createdAt,
        message: `Record created with id: ${path}`
      };
    }
    
    throw new AppError(400, 'invalid_type', `Unknown resource type: ${type}`);
  }

  async handleExec(parameters, context) {
    const { command, args = [], cwd: workingDir, timeout = 30000 } = parameters;
    
    // Safety check: block dangerous commands
    const dangerousCommands = ['rm', 'dd', 'mkfs', 'format', 'del', 'erase', 'fdisk', 'shutdown', 'reboot'];
    const commandBase = command.split(' ')[0].trim();
    
    if (dangerousCommands.includes(commandBase)) {
      throw new AppError(403, 'dangerous_command', `Command '${command}' is not allowed`);
    }
    
    // Resolve working directory
    const resolvedCwd = workingDir ? resolve(workingDir) : process.cwd();
    
    // Security: prevent working directory outside project root
    const projectRoot = process.cwd();
    if (!resolvedCwd.startsWith(projectRoot)) {
      throw new AppError(403, 'path_forbidden', 'Cannot execute commands outside project directory');
    }
    
    try {
      const { stdout, stderr } = await execAsync(
        `${command} ${args.join(' ')}`,
        {
          cwd: resolvedCwd,
          timeout,
          maxBuffer: 1024 * 1024 * 10 // 10MB buffer
        }
      );
      
      return {
        success: true,
        command,
        args,
        exitCode: 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        executedAt: new Date().toISOString()
      };
    } catch (error) {
      // Command failed but still return result
      return {
        success: false,
        command,
        args,
        exitCode: error.code || 1,
        stdout: error.stdout?.trim() || '',
        stderr: error.stderr?.trim() || error.message,
        executedAt: new Date().toISOString()
      };
    }
  }

  async handleRead(parameters, context) {
    const { path, format = 'text' } = parameters;
    
    // Resolve and normalize the path
    const cwd = process.cwd();
    const resolvedPath = path.startsWith('/') ? resolve(path) : join(cwd, path);
    const normalizedPath = normalize(resolvedPath);
    
    this.logger.log(`[ToolHarness] Reading ${format} file at ${normalizedPath} (cwd: ${cwd}, original: ${path})`);
    
    // Security: prevent reading files outside working directory
    if (!normalizedPath.startsWith(cwd)) {
      throw new AppError(403, 'path_forbidden', 'Cannot read files outside working directory');
    }
    
    // Check if file exists
    try {
      await access(normalizedPath, constants.R_OK);
    } catch {
      throw new AppError(404, 'file_not_found', `File not found: ${path}`);
    }
    
    // Read file based on format
    const stats = await stat(normalizedPath);
    
    if (format === 'binary') {
      const buffer = await readFile(normalizedPath);
      return {
        success: true,
        path: normalizedPath,
        format: 'binary',
        content: buffer.toString('base64'),
        size: stats.size,
        readAt: new Date().toISOString()
      };
    }
    
    if (format === 'json') {
      const content = await readFile(normalizedPath, 'utf8');
      try {
        const json = JSON.parse(content);
        return {
          success: true,
          path: normalizedPath,
          format: 'json',
          content: json,
          size: stats.size,
          readAt: new Date().toISOString()
        };
      } catch {
        throw new AppError(400, 'invalid_json', 'File is not valid JSON');
      }
    }
    
    // Default: text format
    const content = await readFile(normalizedPath, 'utf8');
    return {
      success: true,
      path: normalizedPath,
      format: 'text',
      content,
      size: stats.size,
      readAt: new Date().toISOString()
    };
  }

  async handleHelp(parameters, context) {
    const { tool } = parameters;
    
    if (tool) {
      const toolDef = this.getTool(tool);
      return {
        name: toolDef.name,
        description: toolDef.description,
        parameters: toolDef.parameters,
        permissions: toolDef.permissions,
        reversible: toolDef.reversible ?? false,
        dangerous: toolDef.dangerous ?? false
      };
    }
    
    return {
      availableTools: this.listTools(),
      usage: 'Use executeTool with toolName and parameters'
    };
  }
}
