/**
 * MCP Server for AI Test Agent Builder
 * Exposes tools to Cursor via Model Context Protocol
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';

/**
 * MCP Server for AI Test Agent Builder
 */
class TestAgentMCPServer {
  private server: Server;
  private apiUrl: string;

  constructor() {
    this.apiUrl = API_URL;
    this.server = new Server(
      {
        name: 'ai-test-agent-builder',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'ingest_test_book',
            description: 'Upload and parse a test book document (PDF, Word, Excel) to extract test cases',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Path to the test book file',
                },
                sourceType: {
                  type: 'string',
                  enum: ['pdf', 'word', 'excel', 'markdown', 'html', 'text'],
                  description: 'Type of document',
                },
                extractTestCases: {
                  type: 'boolean',
                  description: 'Whether to immediately extract test cases after upload',
                  default: true,
                },
                module: {
                  type: 'string',
                  description: 'Optional module filter for extraction',
                },
                priority: {
                  type: 'string',
                  enum: ['Low', 'Medium', 'High', 'Critical'],
                  description: 'Optional priority filter for extraction',
                },
              },
              required: ['filePath', 'sourceType'],
            },
          },
          {
            name: 'plan_tests',
            description: 'Plan which test cases to run based on agent configuration or filters',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: {
                  type: 'string',
                  description: 'Agent ID to use for planning',
                },
                module: {
                  type: 'string',
                  description: 'Filter by module',
                },
                priority: {
                  type: 'string',
                  enum: ['Low', 'Medium', 'High', 'Critical'],
                  description: 'Filter by priority',
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Filter by tags',
                },
                testIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Specific test case IDs to include',
                },
              },
            },
          },
          {
            name: 'run_api_check',
            description: 'Execute an API test check (GET, POST, PUT, DELETE)',
            inputSchema: {
              type: 'object',
              properties: {
                method: {
                  type: 'string',
                  enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                  description: 'HTTP method',
                },
                url: {
                  type: 'string',
                  description: 'Full URL or endpoint path',
                },
                baseUrl: {
                  type: 'string',
                  description: 'Base URL (if url is relative)',
                },
                headers: {
                  type: 'object',
                  description: 'HTTP headers',
                },
                body: {
                  type: 'object',
                  description: 'Request body (for POST/PUT)',
                },
                expectedStatus: {
                  type: 'number',
                  description: 'Expected HTTP status code',
                },
                expectedBody: {
                  type: 'object',
                  description: 'Expected response body structure',
                },
              },
              required: ['method', 'url'],
            },
          },
          {
            name: 'run_ui_step',
            description: 'Execute a UI test step using Playwright',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['navigate', 'click', 'fill', 'select', 'get_text', 'wait', 'screenshot'],
                  description: 'Action to perform',
                },
                target: {
                  type: 'string',
                  description: 'Selector or URL target',
                },
                data: {
                  type: 'object',
                  description: 'Additional data (e.g., value for fill, option for select)',
                },
                baseUrl: {
                  type: 'string',
                  description: 'Base URL for navigation',
                },
                headless: {
                  type: 'boolean',
                  description: 'Run browser in headless mode',
                  default: true,
                },
              },
              required: ['action', 'target'],
            },
          },
          {
            name: 'start_test_run',
            description: 'Start a test run with an agent',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: {
                  type: 'string',
                  description: 'Agent ID to use for execution',
                },
                environment: {
                  type: 'string',
                  description: 'Environment name',
                },
                metadata: {
                  type: 'object',
                  description: 'Additional metadata',
                },
              },
              required: ['agentId'],
            },
          },
          {
            name: 'get_run_status',
            description: 'Get the status of a test run',
            inputSchema: {
              type: 'object',
              properties: {
                runId: {
                  type: 'string',
                  description: 'Test run ID',
                },
              },
              required: ['runId'],
            },
          },
          {
            name: 'generate_report',
            description: 'Generate test reports for a completed run',
            inputSchema: {
              type: 'object',
              properties: {
                runId: {
                  type: 'string',
                  description: 'Test run ID',
                },
                formats: {
                  type: 'array',
                  items: { type: 'string', enum: ['json', 'html', 'junit'] },
                  description: 'Report formats to generate',
                  default: ['json', 'html'],
                },
              },
              required: ['runId'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'ingest_test_book':
            return await this.handleIngestTestBook(args as any);
          case 'plan_tests':
            return await this.handlePlanTests(args as any);
          case 'run_api_check':
            return await this.handleRunApiCheck(args as any);
          case 'run_ui_step':
            return await this.handleRunUiStep(args as any);
          case 'start_test_run':
            return await this.handleStartTestRun(args as any);
          case 'get_run_status':
            return await this.handleGetRunStatus(args as any);
          case 'generate_report':
            return await this.handleGenerateReport(args as any);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                isError: true,
                error: {
                  code: ErrorCode.InternalError,
                  message: error.message || 'Unknown error',
                },
              }),
            },
          ],
        };
      }
    });
  }

  private async handleIngestTestBook(args: {
    filePath: string;
    sourceType: string;
    extractTestCases?: boolean;
    module?: string;
    priority?: string;
  }) {
    const { filePath, sourceType, extractTestCases = true, module, priority } = args;

    try {
      // Read file and upload via API
      const fs = await import('fs');
      const FormData = (await import('form-data')).default;
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = filePath.split('/').pop() || 'document';

      // Upload document using form-data
      const formData = new FormData();
      formData.append('file', fileBuffer, {
        filename: fileName,
        contentType: this.getContentType(sourceType),
      });

      const uploadResponse = await axios.post(
        `${this.apiUrl}/ingestion/upload`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
        }
      );

      const documentId = uploadResponse.data.id;
      let extractionResult = null;

      // Extract test cases if requested
      if (extractTestCases) {
        const extractResponse = await axios.post(
          `${this.apiUrl}/ingestion/documents/${documentId}/extract`,
          {},
          {
            params: {
              ...(module && { module }),
              ...(priority && { priority }),
            },
          }
        );
        extractionResult = extractResponse.data;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                documentId,
                extracted: extractionResult?.extracted || 0,
                testCases: extractionResult?.testCases || [],
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      throw new Error(`Ingestion failed: ${error.message}`);
    }
  }

  private async handlePlanTests(args: {
    agentId?: string;
    module?: string;
    priority?: string;
    tags?: string[];
    testIds?: string[];
  }) {
    const { agentId, module, priority, tags, testIds } = args;

    try {
      if (agentId) {
        // Use agent configuration for planning
        const agentResponse = await axios.get(`${this.apiUrl}/agents/${agentId}`);
        const agent = agentResponse.data;

        // Create a temporary run to get the plan
        const runResponse = await axios.post(`${this.apiUrl}/runs`, {
          agentId,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  runId: runResponse.data.id,
                  plan: {
                    strategy: `Using agent: ${agent.name}`,
                    tests: runResponse.data.totalTests || 0,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } else {
        // Direct test case query
        const params: any = {};
        if (module) params.module = module;
        if (priority) params.priority = priority;
        if (tags) params.tags = tags.join(',');

        const testCasesResponse = await axios.get(`${this.apiUrl}/testcases`, {
          params,
        });

        const testCases = testIds
          ? testCasesResponse.data.filter((tc: any) => testIds.includes(tc.id))
          : testCasesResponse.data;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  plan: {
                    tests: testCases.map((tc: any) => ({
                      id: tc.id,
                      title: tc.title,
                      module: tc.module,
                      priority: tc.priority,
                    })),
                    count: testCases.length,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }
    } catch (error: any) {
      throw new Error(`Planning failed: ${error.message}`);
    }
  }

  private async handleRunApiCheck(args: {
    method: string;
    url: string;
    baseUrl?: string;
    headers?: Record<string, string>;
    body?: any;
    expectedStatus?: number;
    expectedBody?: any;
  }) {
    const { method, url, baseUrl, headers, body, expectedStatus, expectedBody } = args;

    try {
      const fullUrl = url.startsWith('http') ? url : `${baseUrl || ''}${url}`;

      const response = await axios.request({
        method: method as any,
        url: fullUrl,
        headers: headers || {},
        data: body,
        validateStatus: () => true, // Don't throw on any status
      });

      const passed =
        (!expectedStatus || response.status === expectedStatus) &&
        (!expectedBody || this.matchBody(response.data, expectedBody));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: passed,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                body: response.data,
                expectedStatus,
                expectedBody,
                passed,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  private async handleRunUiStep(args: {
    action: string;
    target: string;
    data?: any;
    baseUrl?: string;
    headless?: boolean;
  }) {
    // For UI steps, we need to call the Python executor
    // This is a simplified version - in production, you'd call the executor service
    const { action, target, data, baseUrl, headless = true } = args;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              message: 'UI step execution requires Python executor',
              action,
              target,
              note: 'Use start_test_run with an agent configured for web testing',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleStartTestRun(args: {
    agentId: string;
    environment?: string;
    metadata?: Record<string, any>;
  }) {
    const { agentId, environment, metadata } = args;

    try {
      const response = await axios.post(`${this.apiUrl}/runs`, {
        agentId,
        metadata: {
          ...metadata,
          environment,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                runId: response.data.id,
                status: response.data.status,
                message: 'Test run started',
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      throw new Error(`Failed to start test run: ${error.message}`);
    }
  }

  private async handleGetRunStatus(args: { runId: string }) {
    const { runId } = args;

    try {
      const response = await axios.get(`${this.apiUrl}/runs/${runId}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                run: {
                  id: response.data.id,
                  status: response.data.status,
                  totalTests: response.data.totalTests,
                  passedTests: response.data.passedTests,
                  failedTests: response.data.failedTests,
                  startedAt: response.data.startedAt,
                  finishedAt: response.data.finishedAt,
                  duration: response.data.duration,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      throw new Error(`Failed to get run status: ${error.message}`);
    }
  }

  private async handleGenerateReport(args: {
    runId: string;
    formats?: string[];
  }) {
    const { runId, formats = ['json', 'html'] } = args;

    try {
      const response = await axios.post(
        `${this.apiUrl}/reports/runs/${runId}/generate`,
        {
          formats,
          includeScreenshots: true,
          includeLogs: true,
        }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                reports: response.data.reports,
                message: response.data.message,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      throw new Error(`Failed to generate report: ${error.message}`);
    }
  }

  private matchBody(actual: any, expected: any): boolean {
    // Simple deep equality check
    return JSON.stringify(actual) === JSON.stringify(expected);
  }

  private getContentType(sourceType: string): string {
    const contentTypes: Record<string, string> = {
      pdf: 'application/pdf',
      word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      markdown: 'text/markdown',
      html: 'text/html',
      text: 'text/plain',
    };
    return contentTypes[sourceType.toLowerCase()] || 'application/octet-stream';
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AI Test Agent Builder MCP Server running on stdio');
  }
}

// Start server
const server = new TestAgentMCPServer();
server.run().catch(console.error);

