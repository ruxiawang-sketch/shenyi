const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// TextIn API 配置
const TEXTIN_APP_ID = 'def2a5dc9635069cff5698b74e16433f';
const TEXTIN_SECRET_CODE = '864abdb8d34cc2c6b0ea4f5646774c3f';
const TEXTIN_BASE = 'https://api.textin.com';

// ========== 辅助函数 ==========

// 调用 TextIn API
async function callTextIn(endpoint, fileBuffer, contentType) {
  const url = `${TEXTIN_BASE}${endpoint}`;
  console.log(`[TextIn] 调用: ${url}`);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-ti-app-id': TEXTIN_APP_ID,
      'x-ti-secret-code': TEXTIN_SECRET_CODE,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: fileBuffer,
  });
  const data = await resp.json();
  console.log(`[TextIn] 响应状态: ${data.code}, message: ${data.message}`);
  return data;
}

// 根据文件扩展名判断 content type
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.tiff': 'image/tiff', '.tif': 'image/tiff',
    '.heic': 'image/heic',
  };
  return map[ext] || 'application/octet-stream';
}

// 自动检测单据类型（基于文件名关键词）
function detectDocType(filename) {
  const name = filename.toLowerCase();
  if (name.includes('发票') || name.includes('invoice')) return 'invoice';
  if (name.includes('回单') || name.includes('receipt')) return 'bank_receipt';
  if (name.includes('对账单') || name.includes('流水') || name.includes('statement')) return 'bank_statement';
  if (name.includes('凭证') || name.includes('voucher')) return 'voucher';
  return 'auto'; // 让 TextIn 自动判断
}

// 单据类型 → TextIn API endpoint 映射
function getEndpoint(docType) {
  const endpoints = {
    'invoice': '/ai/service/v2/recognize/vat_invoice',
    'bank_receipt': '/ai/service/v1/bank_receipt',
    'bank_statement': '/ai/service/v2/recognize/bank_statement',
    'voucher': '/ai/service/v2/recognize/accounting_voucher',
    'auto': '/ai/service/v2/recognize/table',  // 通用表格+文字识别
  };
  return endpoints[docType] || endpoints['auto'];
}

// 单据类型中文名
function getDocTypeName(docType) {
  const names = {
    'invoice': '增值税发票',
    'bank_receipt': '银行回单',
    'bank_statement': '银行对账单',
    'voucher': '记账凭证',
    'auto': '自动识别',
  };
  return names[docType] || '未知';
}

// ========== 格式化识别结果 ==========

// 格式化发票识别结果
function formatInvoice(result) {
  if (!result || !result.result) return { fields: [], rows: [] };
  let r = result.result;
  // TextIn 可能把发票数据嵌套在 pages[0] 或 invoice_list[0] 中
  if (r.pages && r.pages[0]) r = r.pages[0];
  if (r.invoice_list && r.invoice_list[0]) r = r.invoice_list[0];
  if (r.data) r = r.data;

  const item = r.item_list || r.items || r.detail_list || r.goods_list || [];
  const fields = [
    { label: '发票代码', value: r.invoice_code || r.code || '' },
    { label: '发票号码', value: r.invoice_number || r.invoice_no || r.number || '' },
    { label: '开票日期', value: r.invoice_date || r.date || r.billing_date || '' },
    { label: '购买方', value: r.buyer_name || r.purchaser_name || r.buyer || '' },
    { label: '销售方', value: r.seller_name || r.seller || '' },
    { label: '金额', value: r.total_amount || r.amount || r.money || '' },
    { label: '税额', value: r.total_tax || r.tax || r.tax_amount || '' },
    { label: '价税合计', value: r.price_tax_total || r.total || r.sum_amount || '' },
    { label: '校验码', value: r.check_code || r.verify_code || '' },
  ].filter(f => f.value);

  const rows = (item || []).map((it, i) => ({
    序号: i + 1,
    名称: it.name || it.goods_name || it.item_name || '',
    规格: it.specification || it.spec || it.model || '',
    数量: it.quantity || it.num || '',
    单价: it.unit_price || it.price || '',
    金额: it.amount || it.money || '',
    税率: it.tax_rate || it.rate || '',
    税额: it.tax || it.tax_amount || '',
  }));

  return { fields, rows, raw: r };
}

// 格式化银行回单结果
function formatBankReceipt(result) {
  if (!result || !result.result) return { fields: [], rows: [] };
  let r = result.result;
  // TextIn 可能嵌套在 pages[0] 或 data 中
  if (r.pages && r.pages[0]) r = r.pages[0];
  if (r.data) r = r.data;

  // 尝试从 item_list (key-value pairs) 提取字段
  if (r.item_list && r.item_list.length > 0) {
    const fields = r.item_list.map(item => ({
      label: item.key || item.description || item.name || '',
      value: item.value || '',
    })).filter(f => f.label && f.value);
    if (fields.length > 0) return { fields, rows: [], raw: r };
  }

  // 尝试从 object_list 提取
  if (r.object_list && r.object_list.length > 0) {
    const fields = [];
    r.object_list.forEach(obj => {
      if (obj.item_list) {
        obj.item_list.forEach(item => {
          const label = item.key || item.description || '';
          const value = item.value || '';
          if (label && value) fields.push({ label, value });
        });
      }
    });
    if (fields.length > 0) return { fields, rows: [], raw: r };
  }

  // 多条记录格式
  const items = r.items || r.receipts || (Array.isArray(r) ? r : [r]);
  const rows = items.filter(item => item && typeof item === 'object').map((item, i) => ({
    序号: i + 1,
    交易日期: item.date || item.trade_date || item.transaction_date || '',
    付款方: item.payer || item.payer_name || item.from_account_name || '',
    收款方: item.payee || item.payee_name || item.to_account_name || '',
    金额: item.amount || item.trade_amount || '',
    摘要: item.summary || item.remark || item.memo || item.purpose || '',
    流水号: item.serial_number || item.transaction_id || item.ref_no || '',
  })).filter(row => row.付款方 || row.收款方 || row.金额);

  return { fields: [], rows, raw: r };
}

// 格式化银行对账单结果
function formatBankStatement(result) {
  if (!result || !result.result) return { fields: [], rows: [] };
  let r = result.result;
  if (r.pages && r.pages[0]) r = r.pages[0];
  if (r.data) r = r.data;

  const items = r.items || r.transactions || r.details || r.item_list || [];

  if (items.length > 0 && items[0] && (items[0].date || items[0].trade_date || items[0].debit || items[0].credit)) {
    const rows = items.map((item, i) => ({
      序号: i + 1,
      日期: item.date || item.trade_date || '',
      摘要: item.summary || item.description || item.remark || '',
      借方金额: item.debit || item.pay_amount || '',
      贷方金额: item.credit || item.income_amount || '',
      余额: item.balance || '',
    }));
    return { fields: [], rows, raw: r };
  }

  // 降级到通用格式化
  return formatGeneral(result);
}

// 通用格式化（用于自动识别、凭证、table/multipage 接口）
function isRowMeaningful(row) {
  const vals = Object.entries(row)
    .filter(([k]) => !/序号|编号|#|index|no\b/i.test(k))
    .map(([, v]) => String(v).trim())
    .filter(v => v);
  return vals.length >= 2;
}

function formatGeneral(result) {
  if (!result || !result.result) return { fields: [], rows: [] };
  const r = result.result;

  // multipage 接口返回 pages 数组
  if (r.pages && r.pages.length > 0) {
    const allTexts = [];
    const allRows = [];
    r.pages.forEach(page => {
      if (page.lines) {
        page.lines.forEach(l => {
          const t = l.text || l.content || '';
          if (t.trim()) allTexts.push(t);
        });
      }
      // pages 内也可能有 tables
      if (page.tables) {
        page.tables.forEach(table => {
          if (table.rows && table.rows.length > 0) {
            const headerRow = table.rows[0];
            const headers = headerRow.cells ? headerRow.cells.map(c => c.text || c.content || '') : [];
            for (let i = 1; i < table.rows.length; i++) {
              const row = {};
              const cells = table.rows[i].cells || [];
              cells.forEach((cell, ci) => {
                const key = headers[ci] || `列${ci+1}`;
                row[key] = cell.text || cell.content || '';
              });
              if (isRowMeaningful(row)) allRows.push(row);
            }
          }
        });
      }
    });
    const text = allTexts.join('\n');
    return { fields: [], rows: allRows, text: allRows.length === 0 ? text : '', raw: r };
  }

  // table 接口返回 tables 数组
  if (r.tables && r.tables.length > 0) {
    const allRows = [];
    const allTexts = [];
    r.tables.forEach(table => {
      if (table.rows && table.rows.length > 0) {
        const headerRow = table.rows[0];
        const headers = headerRow ? headerRow.cells.map(c => c.text || c.content || '') : [];
        for (let i = 1; i < table.rows.length; i++) {
          const row = {};
          const cells = table.rows[i].cells || [];
          cells.forEach((cell, ci) => {
            const key = headers[ci] || `列${ci+1}`;
            row[key] = cell.text || cell.content || '';
          });
          if (Object.values(row).some(v => v.trim())) {
            allRows.push(row);
          }
        }
      } else if ((table.cells && table.cells.length > 0) || (table.table_cells && table.table_cells.length > 0)) {
        const cellList = (table.cells && table.cells.length > 0) ? table.cells : table.table_cells;
        const grid = {};
        let maxRow = 0, maxCol = 0;
        cellList.forEach(cell => {
          const ri = cell.row != null ? cell.row : (cell.start_row || 0);
          const ci = cell.col != null ? cell.col : (cell.start_col || 0);
          grid[`${ri}_${ci}`] = cell.text || cell.content || '';
          if (ri > maxRow) maxRow = ri;
          if (ci > maxCol) maxCol = ci;
        });
        const headers = [];
        for (let c = 0; c <= maxCol; c++) headers.push(grid[`0_${c}`] || `列${c+1}`);
        for (let ri = 1; ri <= maxRow; ri++) {
          const row = {};
          for (let c = 0; c <= maxCol; c++) {
            row[headers[c]] = grid[`${ri}_${c}`] || '';
          }
          if (isRowMeaningful(row)) allRows.push(row);
        }
      }
      // 提取 table 内的 lines 文字
      if (table.lines && table.lines.length > 0) {
        table.lines.forEach(l => {
          const t = l.text || l.content || '';
          if (t.trim()) allTexts.push(t);
        });
      }
    });
    // 顶层 lines
    let topText = '';
    if (r.lines) {
      topText = r.lines.map(l => l.text || l.content || '').join('\n');
    }
    const tableLineText = allTexts.join('\n');
    const finalText = topText || tableLineText;
    return { fields: [], rows: allRows, text: allRows.length === 0 ? finalText : '', raw: r };
  }

  // 尝试从 object_list 结构中提取
  if (r.object_list || r.objects) {
    const objects = r.object_list || r.objects || [];
    return {
      fields: [],
      rows: objects.map((obj, i) => {
        const row = { 序号: i + 1 };
        if (obj.item_list) {
          obj.item_list.forEach(item => {
            row[item.key || item.description || `字段${item.index}`] = item.value || '';
          });
        }
        return row;
      }),
      raw: r,
    };
  }

  // 文本识别 lines
  if (r.lines) {
    const text = r.lines.map(l => l.text || l.content || '').join('\n');
    return { fields: [], rows: [], text, raw: r };
  }

  // 纯文本
  if (r.text) {
    return { fields: [], rows: [], text: r.text, raw: r };
  }

  // 兜底：把整个 result 当文本展示
  return { fields: [], rows: [], text: JSON.stringify(r, null, 2), raw: r };
}

// ========== AI 结构化提取 ==========
const AI_STRUCTURE_PROMPT = `你是一个财务单据 OCR 结构化提取助手。用户会给你一段 OCR 识别出的文本，你需要分析文本内容，返回 JSON 格式的结构化数据。

要求：
1. 判断单据类型（docType）：invoice(发票)、bank_receipt(银行回单)、bank_statement(银行对账单)、voucher(凭证)、settlement(结算单)、other(其他)
2. 提取关键字段（fields 数组）：如发票号、日期、金额、付款方、收款方等
3. 如果有表格数据，提取为 rows 数组，每行是一个对象
4. 所有金额保持原始格式

严格返回以下 JSON 格式，不要有任何其他文字：
{
  "docType": "invoice",
  "docTypeName": "增值税发票",
  "fields": [{"label": "字段名", "value": "字段值"}],
  "rows": [{"列名1": "值1", "列名2": "值2"}]
}`;

async function aiStructure(ocrText) {
  try {
    console.log('[AI结构化] 开始分析 OCR 文本...');
    const resp = await fetch(`${CLAUDE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLAUDE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        messages: [
          { role: 'system', content: AI_STRUCTURE_PROMPT },
          { role: 'user', content: `以下是 OCR 识别出的文本，请提取结构化数据：\n\n${ocrText}` },
        ],
        max_tokens: 4096,
      }),
    });

    if (!resp.ok) {
      console.error('[AI结构化] API 错误:', resp.status);
      return null;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    // 提取 JSON（可能被 ```json 包裹）
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[AI结构化] 成功: ${parsed.docTypeName}, ${(parsed.fields||[]).length} 字段, ${(parsed.rows||[]).length} 行`);
      return parsed;
    }
    console.error('[AI结构化] 未能解析 JSON');
    return null;
  } catch (err) {
    console.error('[AI结构化] 错误:', err.message);
    return null;
  }
}

// Claude 配置（环境变量优先，本地回退内网代理）
const CLAUDE_BASE = process.env.CLAUDE_BASE || 'http://deepseek-work.intsig.net/proxy/aws/claude/v1';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '019d2e6dd2b876d6992df679e3730917';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// ========== API 路由 ==========

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 单文件识别
app.post('/api/recognize', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }

    const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const docType = req.body.docType || detectDocType(filename);
    const endpoint = getEndpoint(docType);
    const contentType = getContentType(filename);

    console.log(`[识别] 文件: ${filename}, 类型: ${docType}, 大小: ${req.file.size}`);

    let result = await callTextIn(endpoint, req.file.buffer, contentType);
    let usedFallback = false;

    // 专用接口失败时，自动用通用表格接口重试
    if (result.code !== 200 && docType !== 'auto') {
      console.log(`[识别] 专用接口失败(${result.code})，使用通用接口重试: ${filename}`);
      result = await callTextIn(getEndpoint('auto'), req.file.buffer, contentType);
      usedFallback = true;
    }

    if (result.code !== 200) {
      const isClientError = result.code >= 40000 && result.code < 50000;
      return res.status(isClientError ? 400 : 500).json({
        error: `TextIn API 错误: ${result.message || '未知错误'}`,
        code: result.code,
        detail: result,
      });
    }

    // 格式化结果：专用接口成功则用专用格式化，否则通用格式化
    let formatted;
    if (!usedFallback && docType !== 'auto') {
      switch (docType) {
        case 'invoice': formatted = formatInvoice(result); break;
        case 'bank_receipt': formatted = formatBankReceipt(result); break;
        case 'bank_statement': formatted = formatBankStatement(result); break;
        default: formatted = formatGeneral(result); break;
      }
      // 专用格式化结果为空时，降级用通用格式化
      if (formatted.fields.length === 0 && formatted.rows.length === 0 && !formatted.text) {
        console.log(`[识别] 专用格式化结果为空，改用通用格式化: ${filename}`);
        formatted = formatGeneral(result);
      }
    } else {
      formatted = formatGeneral(result);
    }

    res.json({
      success: true,
      filename,
      docType,
      docTypeName: getDocTypeName(docType),
      ...formatted,
    });
  } catch (err) {
    console.error('[识别错误]', err);
    res.status(500).json({ error: err.message });
  }
});

// 批量识别（多文件）
app.post('/api/recognize/batch', upload.array('files', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请上传文件' });
    }

    console.log(`[批量识别] 收到 ${req.files.length} 个文件`);

    const results = [];
    for (const file of req.files) {
      const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const docType = detectDocType(filename);
      const endpoint = getEndpoint(docType);
      const contentType = getContentType(filename);

      try {
        let result = await callTextIn(endpoint, file.buffer, contentType);
        let usedFallback = false;
        if (result.code !== 200 && docType !== 'auto') {
          console.log(`[批量识别] 专用接口失败(${result.code})，通用接口重试: ${filename}`);
          result = await callTextIn(getEndpoint('auto'), file.buffer, contentType);
          usedFallback = true;
        }
        let formatted;
        if (result.code === 200) {
          if (!usedFallback && docType !== 'auto') {
            switch (docType) {
              case 'invoice': formatted = formatInvoice(result); break;
              case 'bank_receipt': formatted = formatBankReceipt(result); break;
              case 'bank_statement': formatted = formatBankStatement(result); break;
              default: formatted = formatGeneral(result); break;
            }
            if (formatted.fields.length === 0 && formatted.rows.length === 0 && !formatted.text) {
              formatted = formatGeneral(result);
            }
          } else {
            formatted = formatGeneral(result);
          }
          results.push({
            success: true, filename, docType,
            docTypeName: getDocTypeName(docType),
            ...formatted,
          });
        } else {
          results.push({
            success: false, filename, docType,
            error: result.message || '识别失败',
          });
        }
      } catch (err) {
        results.push({
          success: false, filename, docType,
          error: err.message,
        });
      }
    }

    res.json({ total: req.files.length, results });
  } catch (err) {
    console.error('[批量识别错误]', err);
    res.status(500).json({ error: err.message });
  }
});

// 指定类型识别
app.post('/api/recognize/:type', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请上传文件' });
    }

    const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const docType = req.params.type;
    const endpoint = getEndpoint(docType);
    const contentType = getContentType(filename);

    console.log(`[指定识别] 文件: ${filename}, 指定类型: ${docType}`);

    const result = await callTextIn(endpoint, req.file.buffer, contentType);

    if (result.code !== 200) {
      return res.status(500).json({
        error: `TextIn API 错误: ${result.message}`,
        code: result.code,
      });
    }

    let formatted;
    switch (docType) {
      case 'invoice': formatted = formatInvoice(result); break;
      case 'bank_receipt': formatted = formatBankReceipt(result); break;
      case 'bank_statement': formatted = formatBankStatement(result); break;
      default: formatted = formatGeneral(result); break;
    }

    res.json({
      success: true, filename, docType,
      docTypeName: getDocTypeName(docType),
      ...formatted,
    });
  } catch (err) {
    console.error('[识别错误]', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== AI 助手（Claude 聊天） ==========
const SYSTEM_PROMPT = `你是「审易 AI 助手」，一个专业的财务审计 AI 助手。你的能力包括：
- 精通中国审计准则（CAS）、会计准则（CAS/IFRS）
- 熟悉审计工作流程：风险评估、实质性程序、函证、抽样、底稿编制
- 能解释异常财务指标的可能原因和审计应对
- 提供审计程序建议和底稿模板参考

回答要求：
1. 简洁专业，直接给出可操作的建议
2. 必要时引用具体准则编号
3. 用结构化格式（要点、步骤）方便审计员快速获取信息
4. 如涉及判断，说明判断依据`;

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: '消息不能为空' });
    }

    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages,
    ];

    console.log(`[AI Chat] 收到消息: ${messages[messages.length - 1].content.substring(0, 50)}...`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const resp = await fetch(`${CLAUDE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLAUDE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        messages: apiMessages,
        max_tokens: 4096,
        stream: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[AI Chat] API 错误: ${resp.status}`, errText);
      res.write(`data: ${JSON.stringify({ error: `API 错误: ${resp.status}` })}\n\n`);
      res.end();
      return;
    }

    resp.body.on('data', (chunk) => {
      res.write(chunk);
    });

    resp.body.on('end', () => {
      res.end();
    });

    resp.body.on('error', (err) => {
      console.error('[AI Chat] Stream error:', err);
      res.end();
    });

  } catch (err) {
    console.error('[AI Chat 错误]', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== 企业信息搜索 ==========
const FAST_MODEL = process.env.FAST_MODEL || 'claude-sonnet-4-20250514';
app.post('/api/suggest-company', async (req, res) => {
  try {
    const query = req.body.query || req.body.filename || '';
    if (!query || query.length < 2) return res.json({ suggestions: [] });

    console.log(`[企业联想] 查询: ${query}`);

    const resp = await fetch(`${CLAUDE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLAUDE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        messages: [
          { role: 'user', content: `企业名联想："${query}"，返回最多5个匹配的知名企业JSON数组，格式：[{"name":"全称","short":"简称","industry":"行业","capital":"注册资本"}]。只返回JSON。不确定则返回[]。` },
        ],
        max_tokens: 512,
      }),
    });

    if (!resp.ok) return res.json({ suggestions: [] });

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '[]';
    const arrMatch = content.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try {
        const arr = JSON.parse(arrMatch[0]);
        return res.json({ suggestions: arr.slice(0, 5) });
      } catch(e) {}
    }
    res.json({ suggestions: [] });
  } catch (err) {
    console.error('[企业联想] 错误:', err.message);
    res.json({ suggestions: [] });
  }
});

app.post('/api/search-company', async (req, res) => {
  try {
    const { company, extra } = req.body;
    if (!company) return res.status(400).json({ error: '公司名不能为空' });

    console.log(`[企业搜索] 搜索: ${company}`);

    const searchPrompt = `整理企业"${company}"的公开工商信息，用于审计计划编制。
${extra ? '补充：' + extra : ''}

要求：
- 基于你训练数据中的公开信息（工商登记、年报、新闻等）尽可能完整填写
- 对于知名企业/上市公司，你应该知道大部分信息，请放心输出
- 只有确实完全没有任何线索的字段才标注"[未查到]"
- 注册资本、法定代表人、成立日期、经营范围这些工商信息对知名企业是公开的，请务必填写

返回JSON：
{
  "basic": { "注册资本": "", "成立日期": "", "法定代表人": "", "信用代码": "", "注册地址": "" },
  "business": "经营范围详细描述",
  "industry": "行业分类",
  "shareholders": "股东信息",
  "financials": "财务概况（营收规模等）",
  "related": "主要关联公司",
  "risks": "公开风险信息",
  "industryFocus": "该行业审计关注点（3-5条具体审计风险）"
}
只返回JSON，不要其他内容。`;

    const resp = await fetch(`${CLAUDE_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLAUDE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        messages: [
          { role: 'system', content: '你是企业工商信息查询助手。你的训练数据包含大量中国企业的公开工商登记信息。对于知名企业（尤其是上市公司、大型集团），你应当能提供详细的注册信息、经营范围、股东结构等。请尽可能完整地回忆和整理这些公开信息。' },
          { role: 'user', content: searchPrompt },
        ],
        max_tokens: 4096,
      }),
    });

    if (!resp.ok) {
      console.error('[企业搜索] API 错误:', resp.status);
      return res.status(500).json({ error: `API 错误: ${resp.status}` });
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('[企业搜索] 成功');
        return res.json({ success: true, data: parsed, raw: content });
      } catch (e) {}
    }
    res.json({ success: true, data: null, raw: content });
  } catch (err) {
    console.error('[企业搜索] 错误:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== 服务器端数据持久化 ==========
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 200);
}

// 获取所有 keys
app.get('/api/state', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const keys = files.map(f => f.replace('.json', ''));
    res.json({ keys });
  } catch (e) {
    res.json({ keys: [] });
  }
});

// 读取某个 key 的数据
app.get('/api/state/:key', (req, res) => {
  const file = path.join(DATA_DIR, safeKey(req.params.key) + '.json');
  if (!fs.existsSync(file)) return res.json({ value: null });
  try {
    const raw = fs.readFileSync(file, 'utf8');
    res.json({ value: JSON.parse(raw) });
  } catch (e) {
    res.json({ value: null });
  }
});

// 写入某个 key 的数据
const LOCAL_ONLY_PREFIXES = ['audit_doc_plan_', 'audit_doc_analysis_', 'audit_doc_adjust_', 'audit_doc_report_'];
app.put('/api/state/:key', (req, res) => {
  const key = req.params.key;
  if (LOCAL_ONLY_PREFIXES.some(p => key.startsWith(p))) {
    return res.json({ ok: true, skipped: true });
  }
  const file = path.join(DATA_DIR, safeKey(key) + '.json');
  try {
    fs.writeFileSync(file, JSON.stringify(req.body.value), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除某个 key
app.delete('/api/state/:key', (req, res) => {
  const file = path.join(DATA_DIR, safeKey(req.params.key) + '.json');
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 批量读取
app.post('/api/state/batch-get', (req, res) => {
  const keys = req.body.keys || [];
  const result = {};
  for (const key of keys) {
    const file = path.join(DATA_DIR, safeKey(key) + '.json');
    try {
      if (fs.existsSync(file)) {
        result[key] = JSON.parse(fs.readFileSync(file, 'utf8'));
      } else {
        result[key] = null;
      }
    } catch { result[key] = null; }
  }
  res.json(result);
});

// 所有未匹配路由返回 index.html（SPA fallback）
app.get('/{0,}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== 启动 ==========
const PORT = process.env.PORT || 3200;
app.listen(PORT, () => {
  console.log(`\n🚀 审易 AI 审计助手已启动`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   TextIn API: 已配置\n`);
});
