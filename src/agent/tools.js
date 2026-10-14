export function buildTools(cfg) {
  const maxSites = cfg.maxSites;
  const ttlMin = Math.round(cfg.siteTtlSeconds / 60);

  return [
    {
      type: 'function',
      function: {
        name: 'deploy_site',
        description:
          '把一段前端代码部署成一个真实可访问的网页,立刻生效并返回网址。' +
          '当用户要「写一个小游戏 / 做个网页 / 写个工具 / 做个小应用」时,必须用这个工具把代码部署出去,' +
          '不要试图把整段代码贴在聊天里(QQ 消息长度有限,贴出来也是残缺的)。' +
          'files 里至少要有一个 index.html;可以额外放 style.css、app.js 等。' +
          '前端可以用 fetch("./__data/<键>") 做 GET、用 fetch("./__data/<键>",{method:"POST",body:"..."}) 做 POST,' +
          '来把数据存在服务端(适合排行榜、存档),这是本平台内置的简易后端。' +
          `同一时间最多存在 ${maxSites} 个部署,超了会自动删掉最久没改动的那一个;` +
          `每个部署 ${ttlMin} 分钟后自动销毁,期间只要再改一次就会重新计时。` +
          '部署成功后必须把返回的链接原样告诉用户。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '项目短名,例如「2048 小游戏」' },
            description: { type: 'string', description: '一句话说明这个网页是干什么的' },
            files: {
              type: 'array',
              description: '文件列表,路径用相对路径,例如 index.html / style.css / app.js',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: '文件名,例如 index.html' },
                  content: { type: 'string', description: '文件完整内容' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['name', 'files'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_site',
        description:
          '修改一个已经部署的网页。只传要改的文件即可,同名文件会被覆盖,没提到的文件保持原样。' +
          '修改成功会重置该站点的销毁倒计时。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '部署 ID(8 位英文数字,例如 ab3k9m2p)' },
            name: { type: 'string', description: '可选,顺便改个项目名' },
            files: {
              type: 'array',
              description: '要写入或覆盖的文件',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  content: { type: 'string' },
                },
                required: ['path', 'content'],
              },
            },
          },
          required: ['id', 'files'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_sites',
        description: '列出当前所有在线部署(含 ID、网址、剩余存活时间、文件清单)。用户问「现在有几个项目」时用。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_site',
        description: '读取某个已部署站点的文件内容,改代码之前先看一遍。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '部署 ID' },
            path: { type: 'string', description: '可选,只看某个文件;不填则返回文件清单和每个文件的前 800 字' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_site',
        description: '删除一个部署,删除后链接立刻失效。用户说「删掉那个网页」时用。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '部署 ID' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索。需要最新消息、实时数据、你不确定的事实时调用。返回标题、网址和摘要。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            count: { type: 'integer', description: '返回条数,默认 5,最多 8' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: '抓取一个网页的正文纯文本。已知具体网址时用它读原文。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整网址,必须以 http:// 或 https:// 开头' },
            max_chars: { type: 'integer', description: '最多返回多少字符,默认 4000' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'query_dashboard',
        description: '查询当前 AI 中转站的实时用量:剩余额度、累计请求数、token 数、最近调用记录。'
          + '用户问「还剩多少额度」「中转站用量」「今天用了多少」时用。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remember',
        description: '把一条信息长期记住(比如群规、某人的偏好、约好的时间)。'
          + '记住之后,以后这个会话的每次对话都会自动带上它。用户说「记住 xxx」「以后都 xxx」时用。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '简短的名字,例如「群活动时间」' },
            value: { type: 'string', description: '具体内容,例如「每周五晚八点开黑」' },
          },
          required: ['key', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall',
        description: '查看这个会话已经记住的全部内容。用户问「你记得什么」时用。',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'forget',
        description: '忘掉一条之前记住的信息。用户说「忘掉 xxx」「不用记着了」时用。',
        parameters: {
          type: 'object',
          properties: { key: { type: 'string', description: '要忘掉的那条的名字' } },
          required: ['key'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'random',
        description: '掷骰子、抽签、生成随机数。给 choices 就是从候选里抽一个(比如「今天谁请客」);'
          + '给 min/max 就是范围内随机整数。',
        parameters: {
          type: 'object',
          properties: {
            choices: {
              type: 'array',
              description: '候选列表,例如 ["小明","小红","小刚"]',
              items: { type: 'string' },
            },
            min: { type: 'number', description: '最小值,默认 1' },
            max: { type: 'number', description: '最大值,默认 100' },
            count: { type: 'integer', description: '抽几个,默认 1,最多 20' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'encode',
        description: '编解码与格式化工具:Base64 / URL / 十六进制互转,JSON 美化或压缩。'
          + '用户贴了一段编码后的内容让你看,或者要你把内容编码时用。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'base64_encode / base64_decode / url_encode / url_decode / '
                + 'hex_encode / hex_decode / json_pretty / json_minify',
            },
            text: { type: 'string', description: '要处理的内容' },
          },
          required: ['action', 'text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'calc',
        description: '精确计算数学表达式。凡是算术都优先用它,不要心算。支持 + - * / % ^ ( )、sqrt/log/sin 等函数、pi 和 e。',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', description: '例如 (17*23+5)/4 或 sqrt(2)*10' } },
          required: ['expression'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'now',
        description: '获取当前日期和时间(北京时间)。涉及「今天」「现在」「几天后」时用。',
        parameters: {
          type: 'object',
          properties: {
            offset_hours: { type: 'number', description: '可选,时区偏移,默认 8(北京时间)' },
          },
        },
      },
    },
      ...SANDBOX_TOOLS,
  ];
}

const SANDBOX_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fs_write',
      description: '在沙盒里创建或覆盖一个文件。沙盒是给你写代码用的草稿区(2 MB 上限),不会对外公开;'
        + '想让人看到要用 fs_deploy 或 deploy_site 部署出去。适合先写好几个文件再一起部署。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径,例如 index.html 或 css/style.css' },
          content: { type: 'string', description: '文件完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description: '读取沙盒里某个文件的内容。改代码之前先看一遍。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description: '列出沙盒里有哪些文件,以及每个文件的大小。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '可选,只看某个目录下的文件' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_edit',
      description: '在沙盒文件里做局部替换。适合只改几行,不用把整个文件重写一遍。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          find: { type: 'string', description: '要被替换掉的原文本(必须和文件里完全一致)' },
          replace: { type: 'string', description: '替换成什么' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_delete',
      description: '删掉沙盒里的一个文件。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_deploy',
      description: '把沙盒里的文件直接部署成公开网页,返回链接。'
        + '不填 paths 就部署沙盒里的全部文件;必须包含 index.html。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '项目名,中英文数字都行' },
          description: { type: 'string', description: '一句话说明' },
          dir: { type: 'string', description: '可选,只部署某个目录下的文件' },
          paths: {
            type: 'array',
            description: '可选,只部署这些文件',
            items: { type: 'string' },
          },
        },
        required: ['name'],
      },
    },
  },
];
