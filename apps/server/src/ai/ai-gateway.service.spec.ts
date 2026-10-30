import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compile, providePrisma } from '../testing/fixtures.js';
import { AiGatewayService } from './ai-gateway.service.js';

const create = vi.hoisted(() => vi.fn());

vi.mock('./moonshot.client.js', () => ({
  MOONSHOT_MODEL: 'kimi-k2.6',
  configuredExtractionModel: () => 'kimi-k2.6',
  configuredClassificationModel: () => 'kimi-k2.6',
  moonshotClient: () => ({
    chat: { completions: { create } },
  }),
}));

describe('AiGatewayService', () => {
  const prisma = {
    systemSetting: { findUnique: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOONSHOT_API_KEY = 'test-key';
    process.env.AI_ENABLED = 'true';
    delete process.env.AI_KILL_SWITCH;
    delete process.env.AI_KILL_SWITCH_ENGAGED;
    prisma.systemSetting.findUnique.mockResolvedValue(null);
  });

  async function service() {
    return compile(AiGatewayService, [providePrisma(prisma)]);
  }

  it('keeps a field proposal only when the value is in the document', async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'propose_fields',
                  arguments: JSON.stringify({
                    fields: [
                      {
                        name: 'vendor_name',
                        value: 'Acme Supplies',
                        quote: 'Vendor: Acme Supplies',
                      },
                      {
                        name: 'total',
                        value: '999.00',
                        quote: 'Total 999.00',
                      },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const result = await (
      await service()
    ).suggestFields('TAX INVOICE\nVendor: Acme Supplies\nTotal JMD 12.50', 'invoice', [
      'vendor_name',
      'total',
    ]);

    expect(result.outcome).toBe('answered');
    expect(result.suggestions).toEqual([
      {
        name: 'vendor_name',
        text: 'Acme Supplies',
        quote: 'Vendor: Acme Supplies',
      },
    ]);
    expect(result.discarded).toBe(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'kimi-k2.6',
        temperature: 0.6,
        tool_choice: {
          type: 'function',
          function: { name: 'propose_fields' },
        },
        thinking: { type: 'disabled' },
      }),
    );
  });

  it('does not call Moonshot when the kill switch is engaged', async () => {
    process.env.AI_KILL_SWITCH = 'true';

    const result = await (
      await service()
    ).suggestFields('TAX INVOICE', 'invoice', ['vendor_name']);

    expect(result.outcome).toBe('kill_switch');
    expect(create).not.toHaveBeenCalled();
  });

  it('names a document kind only when the quote is on the page', async () => {
    create.mockResolvedValueOnce({
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: 'function',
                function: {
                  name: 'propose_kind',
                  arguments: JSON.stringify({
                    kind: 'invoice',
                    quote: 'TAX INVOICE',
                  }),
                },
              },
            ],
          },
        },
      ],
    });

    const result = await (await service()).suggestKind('TAX INVOICE\nAcme');

    expect(result.outcome).toBe('answered');
    expect(result.kind).toBe('invoice');
  });
});
