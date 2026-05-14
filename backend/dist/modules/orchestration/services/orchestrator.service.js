/**
 * Orchestrator Service
 * Supervises the entire test execution workflow with improved concurrency
 */
import { AgentRepository } from '../../../core/repositories/agent.repository.js';
import { RunRepository } from '../../../core/repositories/run.repository.js';
import { PlannerAgentService } from '../../agents/services/planner-agent.service.js';
import { EnvironmentAgentService } from '../../agents/services/environment-agent.service.js';
import { getWebSocketService } from '../../../infra/websocket/server.js';
import logger from '../../../infra/logger/index.js';
import { spawn } from 'child_process';
import { join } from 'path';
import { EventEmitter } from 'events';
/**
 * Concurrency manager for test execution
 */
class ConcurrencyManager extends EventEmitter {
    running = new Set();
    queue = [];
    maxConcurrent;
    constructor(maxConcurrent = 5) {
        super();
        this.maxConcurrent = maxConcurrent;
    }
    async execute(runId, priority, task) {
        return new Promise((resolve, reject) => {
            const executeTask = async () => {
                if (this.running.size >= this.maxConcurrent) {
                    this.queue.push({ runId, priority });
                    this.queue.sort((a, b) => b.priority - a.priority);
                    return;
                }
                this.running.add(runId);
                this.emit('started', runId);
                try {
                    await task();
                    resolve();
                }
                catch (error) {
                    reject(error);
                }
                finally {
                    this.running.delete(runId);
                    this.emit('completed', runId);
                    // Process next in queue
                    if (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
                        const next = this.queue.shift();
                        if (next) {
                            // This will be handled by the caller
                            setImmediate(() => this.execute(next.runId, next.priority, task));
                        }
                    }
                }
            };
            executeTask();
        });
    }
    getRunningCount() {
        return this.running.size;
    }
    getQueueLength() {
        return this.queue.length;
    }
}
export class OrchestratorService {
    agentRepo = new AgentRepository();
    runRepo = new RunRepository();
    plannerAgent = new PlannerAgentService();
    environmentAgent = new EnvironmentAgentService();
    concurrencyManager;
    constructor(maxConcurrentRuns = 5) {
        this.concurrencyManager = new ConcurrencyManager(maxConcurrentRuns);
        // Listen to concurrency events
        this.concurrencyManager.on('started', (runId) => {
            logger.info('Test run started', { runId, running: this.concurrencyManager.getRunningCount() });
        });
        this.concurrencyManager.on('completed', (runId) => {
            logger.info('Test run completed', { runId, running: this.concurrencyManager.getRunningCount() });
        });
    }
    /**
     * Start a test run with concurrency control
     */
    async startRun(input) {
        // Create run record
        const run = await this.runRepo.createRun(input);
        // Fetch agent
        const agent = await this.agentRepo.findById(input.agentId);
        if (!agent) {
            throw new Error(`Agent not found: ${input.agentId}`);
        }
        // Determine priority (Critical=4, High=3, Medium=2, Low=1)
        const priority = this.calculatePriority(agent.config);
        // Setup environment if configured
        if (agent.config.environment) {
            try {
                const envConfig = {
                    name: agent.config.environment,
                    baseUrl: agent.config.base_url,
                };
                await this.environmentAgent.setupEnvironment(envConfig);
            }
            catch (error) {
                logger.warn('Environment setup failed, continuing', { error: error.message });
            }
        }
        // Create test plan
        const plan = await this.plannerAgent.createTestPlan(agent.config);
        // Update run status
        await this.runRepo.updateRun(run.id, { status: 'running' });
        // Broadcast run started via WebSocket
        const wsService = getWebSocketService();
        if (wsService) {
            wsService.broadcastRunProgress(run.id, {
                status: 'running',
                completed: 0,
                total: plan.tests.length,
                passed: 0,
                failed: 0,
            });
        }
        // Execute with concurrency control
        this.concurrencyManager.execute(run.id, priority, async () => {
            await this.executeRun(run.id, agent, plan);
        }).catch((error) => {
            logger.error('Test execution failed', { runId: run.id, error: error.message });
            this.runRepo.updateRun(run.id, {
                status: 'failed',
                finishedAt: new Date(),
            });
        });
        return run;
    }
    /**
     * Calculate priority for concurrency management
     */
    calculatePriority(config) {
        const priorities = config.test_selection?.priority || [];
        if (priorities.includes('Critical'))
            return 4;
        if (priorities.includes('High'))
            return 3;
        if (priorities.includes('Medium'))
            return 2;
        return 1;
    }
    /**
     * Execute a test run
     */
    async executeRun(runId, agent, plan) {
        try {
            logger.info('Starting test execution', { runId, agentId: agent.id, testCount: plan.tests.length });
            // Call Python executor
            const executorPath = join(process.cwd(), 'executor/src/runner/test_runner.py');
            const pythonProcess = spawn('python3', [
                executorPath,
                '--run-id', runId,
                '--agent-config', JSON.stringify(agent.config),
                '--test-ids', plan.tests.join(','),
            ], {
                cwd: process.cwd(),
            });
            let stdout = '';
            let stderr = '';
            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
                logger.info('Executor output', { runId, output: data.toString() });
                // Broadcast progress updates
                const wsService = getWebSocketService();
                if (wsService) {
                    // Parse progress if available
                    try {
                        const progressMatch = stdout.match(/(\d+)\/(\d+)/);
                        if (progressMatch) {
                            const completed = parseInt(progressMatch[1]);
                            const total = parseInt(progressMatch[2]);
                            wsService.broadcastRunProgress(runId, {
                                status: 'running',
                                completed,
                                total,
                                passed: 0,
                                failed: 0,
                            });
                        }
                    }
                    catch (e) {
                        // Ignore parsing errors
                    }
                }
            });
            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
                logger.error('Executor error', { runId, error: data.toString() });
            });
            pythonProcess.on('close', async (code) => {
                const updatedRun = await this.runRepo.findRunById(runId);
                if (updatedRun) {
                    await this.runRepo.updateRunStats(runId);
                }
                if (code === 0) {
                    await this.runRepo.updateRun(runId, {
                        status: 'completed',
                        finishedAt: new Date(),
                    });
                    const finalRun = await this.runRepo.findRunById(runId);
                    const wsService = getWebSocketService();
                    if (wsService && finalRun) {
                        wsService.broadcastRunCompleted(runId, {
                            status: 'completed',
                            total: finalRun.totalTests,
                            passed: finalRun.passedTests,
                            failed: finalRun.failedTests,
                        });
                    }
                    logger.info('Test execution completed', { runId });
                }
                else {
                    await this.runRepo.updateRun(runId, {
                        status: 'failed',
                        finishedAt: new Date(),
                    });
                    const wsService = getWebSocketService();
                    if (wsService) {
                        wsService.broadcastRunCompleted(runId, {
                            status: 'failed',
                            error: 'Test execution failed',
                        });
                    }
                    logger.error('Test execution failed', { runId, exitCode: code });
                }
            });
        }
        catch (error) {
            logger.error('Execution error', { runId, error: error.message });
            await this.runRepo.updateRun(runId, {
                status: 'failed',
                finishedAt: new Date(),
            });
            throw error;
        }
    }
    /**
     * Get run status
     */
    async getRunStatus(runId) {
        return await this.runRepo.findRunById(runId);
    }
    /**
     * Cancel a running test
     */
    async cancelRun(runId) {
        const run = await this.runRepo.findRunById(runId);
        if (!run) {
            throw new Error(`Run not found: ${runId}`);
        }
        if (run.status !== 'running') {
            throw new Error(`Cannot cancel run with status: ${run.status}`);
        }
        await this.runRepo.updateRun(runId, {
            status: 'cancelled',
            finishedAt: new Date(),
        });
    }
    /**
     * Get concurrency statistics
     */
    getConcurrencyStats() {
        return {
            running: this.concurrencyManager.getRunningCount(),
            queued: this.concurrencyManager.getQueueLength(),
            maxConcurrent: this.concurrencyManager['maxConcurrent'],
        };
    }
}
//# sourceMappingURL=orchestrator.service.js.map