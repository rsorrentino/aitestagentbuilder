/**
 * CLI Interface
 */
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { AgentRepository } from '../core/repositories/agent.repository.js';
import { OrchestratorService } from '../modules/orchestration/services/orchestrator.service.js';
import { ReportingAgentService } from '../modules/reporting/services/reporting-agent.service.js';
import logger from '../infra/logger/index.js';
const program = new Command();
program
    .name('ai-test-agent')
    .description('AI Test Agent Builder CLI')
    .version('1.0.0');
program
    .command('run')
    .description('Run tests using an agent configuration')
    .requiredOption('-c, --config <path>', 'Path to agent configuration YAML file')
    .option('-e, --environment <env>', 'Environment override', 'staging')
    .action(async (options) => {
    try {
        const configPath = options.config;
        const configContent = readFileSync(configPath, 'utf-8');
        // Parse YAML
        const yaml = await import('yaml');
        const config = yaml.parse(configContent);
        const agentRepo = new AgentRepository();
        const orchestrator = new OrchestratorService();
        // Create or find agent
        let agent = await agentRepo.findByName(config.agent_name);
        if (!agent) {
            agent = await agentRepo.create({
                name: config.agent_name,
                config: config,
            });
        }
        // Override environment if provided
        if (options.environment) {
            agent.config.environment = options.environment;
        }
        // Start run
        console.log(`Starting test run with agent: ${agent.name}`);
        const run = await orchestrator.startRun({
            agentId: agent.id,
            metadata: {
                environment: options.environment,
                triggeredBy: 'cli',
            },
        });
        console.log(`Test run started: ${run.id}`);
        console.log(`Status: ${run.status}`);
        console.log(`Monitor progress: GET /api/v1/runs/${run.id}`);
    }
    catch (error) {
        logger.error('CLI run failed', { error: error.message });
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
});
program
    .command('report')
    .description('Generate reports for a test run')
    .requiredOption('-r, --run-id <id>', 'Test run ID')
    .option('-f, --formats <formats>', 'Report formats (comma-separated)', 'json,html')
    .option('-o, --output <path>', 'Output directory', './reports')
    .action(async (options) => {
    try {
        const reportingAgent = new ReportingAgentService();
        const formats = options.formats.split(',');
        const reportPaths = await reportingAgent.generateReports(options.runId, {
            formats,
            includeScreenshots: true,
            includeLogs: true,
            outputPath: options.output,
        });
        console.log(`Generated ${reportPaths.length} report(s):`);
        reportPaths.forEach(path => console.log(`  - ${path}`));
    }
    catch (error) {
        logger.error('CLI report generation failed', { error: error.message });
        console.error(`Error: ${error.message}`);
        process.exit(1);
    }
});
program.parse();
//# sourceMappingURL=index.js.map