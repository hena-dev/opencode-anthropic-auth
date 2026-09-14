import { expect, test } from 'bun:test'
import { createStrippedStream, rewriteRequestBody } from '../transform'

test('tool aliases are reversible, collision-free, and used by history and forced selection', async () => {
  const original = [
    'read',
    'Read',
    'mcp_Read',
    'a'.repeat(70),
    `${'a'.repeat(69)}b`,
    'namespace.tool',
  ]
  const names = new Map<string, string>()
  const rewritten = JSON.parse(
    rewriteRequestBody(
      JSON.stringify({
        tools: [
          ...original.map((name) => ({
            name,
            input_schema: { type: 'object' },
          })),
          { type: 'web_search_20250305', name: 'web_search' },
        ],
        messages: [
          {
            role: 'assistant',
            content: original.map((name, i) => ({
              type: 'tool_use',
              name,
              id: `tool_${i}`,
              input: {},
            })),
          },
        ],
        tool_choice: { type: 'tool', name: 'Read' },
      }),
      '9.8.7',
      names,
    ),
  )
  expect(names.size).toBe(original.length)
  expect(
    [...names.keys()].every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)),
  ).toBe(true)
  expect(rewritten.tool_choice.name).toBe(rewritten.tools[1].name)
  expect(rewritten.tools.at(-1).name).toBe('web_search')
  const content = rewritten.messages[0].content
  expect(content.map((block: { name: string }) => block.name)).toEqual([
    ...names.keys(),
  ])
  const restored = createStrippedStream(
    Response.json({ type: 'message', content }),
    names,
  )
  expect(await restored.json()).toEqual({
    type: 'message',
    content: original.map((name, i) => ({
      type: 'tool_use',
      name,
      id: `tool_${i}`,
      input: {},
    })),
  })
})

test('SSE restores tool calls at every byte boundary, including UTF-8 and CRLF', async () => {
  const text =
    'event: content_block_start\r\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read","id":"tool_1","input":{}}}\r\n\r\n' +
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"é 🐈 mcp_Read"}}\n\n' +
    'data: {"type":"content_block_start","content_block":{"type":"server_tool_use","name":"mcp_Read"}}\n\n'
  const bytes = new TextEncoder().encode(text)
  for (let split = 1; split < bytes.length; split++) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split))
        controller.enqueue(bytes.slice(split))
        controller.close()
      },
    })
    const response = createStrippedStream(
      new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'content-length': String(bytes.length),
          etag: 'old',
        },
      }),
      new Map([['mcp_Read', 'Read']]),
    )
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('etag')).toBeNull()
    const result = await response.text()
    expect(result).toContain('"name":"Read"')
    expect(result).toContain('é 🐈 mcp_Read')
    expect(result).toContain('"type":"server_tool_use","name":"mcp_Read"')
  }
})

test('SSE multiline data and final unterminated frames are restored', async () => {
  const response = new Response(
    'data: {"type":"content_block_start",\ndata: "content_block":{"type":"tool_use","name":"mcp_Read"}}',
    { headers: { 'content-type': 'text/event-stream' } },
  )
  expect(
    await createStrippedStream(
      response,
      new Map([['mcp_Read', 'Read']]),
    ).text(),
  ).toContain('"name":"Read"')
})

test('cancellation reaches the source stream', async () => {
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  await createStrippedStream(
    response,
    new Map([['mcp_Read', 'Read']]),
  ).body!.cancel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(cancelled).toBe(true)
})

test('upstream errors propagate through the response transform', async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('stream failed'))
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  await expect(
    createStrippedStream(response, new Map([['mcp_Read', 'Read']])).text(),
  ).rejects.toThrow('stream failed')
})

test('error and non-JSON responses remain untouched', () => {
  for (const response of [
    Response.json({ error: { name: 'mcp_Read' } }, { status: 429 }),
    new Response('plain text'),
  ]) {
    expect(
      createStrippedStream(response, new Map([['mcp_Read', 'Read']])),
    ).toBe(response)
  }
})
