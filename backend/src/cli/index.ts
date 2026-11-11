/**
 * CLI Interface
 *
 *   npm run cli -- run -c ../configs/login-agent.yml
 *   npm run cli -- report -r RUN-123 -f html,junit -o ./reports
 *
 * `run` waits for the run to finish, writes reports and exits with code 1
 * when any test failed — suitable for CI pipelines.
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import '../infra/config/env.js';
import { AgentRepository } from '../core/repositories/agent.repository.js';
import { RunRepository } from '../core/repositories/run.repository.js';
import { OrchestratorService } from '../modules/orchestration/services/orchestrator.service.js';
import { ReportFormat, ReportingAgentService } from '../modules/reporting/services/reporting-agent.service.js';
import { buildAgentConfig } from '../api/controllers/agents.controller.js';
import { runMigrations } from '../infra/db/migrate.js';
import getDatabaseClient from '../infra/db/client.js';
import { CopilotClient } from '../infra/llm/copilot.js';

const program = new Command();

program
  .name('ai-test-agent')
  .description('AI Test Agent Builder CLI')
  .version('1.0.0');

async function finish(code: number): Promise<never> {
  await CopilotClient.shutdown();
  await getDatabaseClient().close().catch(() => undefined);
  process.exit(code);
}

program
  .command('run')
  .description('Run the tests selected by an agent configuration (YAML) and wait for the result')
  .requiredOption('-c, --config <path>', 'Path to agent configuration YAML file')
  .option('-e, --environment <env>', 'Environment override')
  .option('-o, --output <path>', 'Report output directory', './reports')
  .option('-f, --formats <formats>', 'Report formats (comma-separated)', 'html,junit,json')
  .option('-p, --project <id>', 'Project ID', process.env.PROJECT_ID || 'default')
  .action(async (options) => {
    try {
      await runMigrations();
      const yaml = await import('yaml');
      // ${VAR} placeholders are replaced with environment variables
      const text = readFileSync(options.config, 'utf-8').replace(/\$\{(\w+)\}/g, (_m, name) => process.env[name] ?? '');
      const raw = yaml.parse(text);
      const name = raw.agent_name || raw.name;
      if (!name) throw new Error('The config needs an agent_name');
      if (options.environment) raw.environment = options.environment;

      const { errors, config } = buildAgentConfig(name, raw);
      if (errors.length) throw new Error(errors.join('; '));

      const agentRepo = new AgentRepository();
      const projectId = String(options.project);
      let agent = await agentRepo.findByName(name, projectId);
      agent = agent
        ? (await agentRepo.update(agent.id, { config: config! }, projectId))!
        : await agentRepo.create({ name, config: config!, projectId });

      console.log(`▶ Agent "${agent.name}" → ${agent.config.base_url}`);
      const run = await OrchestratorService.get().startRun({
        agentId: agent.id,
        projectId,
        metadata: { environment: agent.config.environment, triggeredBy: 'cli' },
      });
      console.log(`  Run ${run.id}: ${run.totalTests} test(s)`);

      const runRepo = new RunRepository();
      let current = await runRepo.findRunById(run.id);
      let printed = 0;
      while (current && (current.status === 'pending' || current.status === 'running')) {
        await new Promise((r) => setTimeout(r, 1000));
        current = await runRepo.findRunById(run.id);
        const done = (current?.results ?? []).filter((r) => r.status !== 'running');
        for (const r of done.slice(printed)) {
          const icon = r.status === 'passed' ? '✓' : r.status === 'skipped' ? '○' : '✗';
          console.log(`  ${icon} ${r.metadata?.title ?? r.testCaseId}${r.error ? ` — ${r.error}` : ''}`);
        }
        printed = done.length;
      }

      if (!current) throw new Error('Run disappeared');
      console.log(`\n${current.status.toUpperCase()}: ${current.passedTests} passed, ${current.failedTests} failed, ${current.skippedTests} skipped`);

      const reports = await new ReportingAgentService().generateReports(run.id, {
        formats: String(options.formats).split(',') as ReportFormat[],
        includeLogs: true,
        includeScreenshots: true,
        outputPath: options.output,
      });
      reports.forEach((p) => console.log(`  report: ${p}`));

      await finish(current.status === 'completed' ? 0 : 1);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      await finish(1);
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
      const reportPaths = await new ReportingAgentService().generateReports(options.runId, {
        formats: options.formats.split(',') as ReportFormat[],
        includeScreenshots: true,
        includeLogs: true,
        outputPath: options.output,
      });
      console.log(`Generated ${reportPaths.length} report(s):`);
      reportPaths.forEach(path => console.log(`  - ${path}`));
      await finish(0);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      await finish(1);
    }
  });

program.parse();
