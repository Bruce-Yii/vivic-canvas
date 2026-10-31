import{i as e}from"./rolldown-runtime-Dd_uD5pT.js";import{n as t,t as n}from"./jsx-runtime-DKj5X9O4.js";import{n as r,v as i,y as a}from"./main-CGeA_2m5.js";import{o}from"./files-BIXx7zeZ.js";import{t as s}from"./createLucideIcon-s2gBhvio.js";import{n as c,r as l,t as u}from"./VivicCard-B1765qP5.js";import{canonicalJson as d,definitionKey as f,definitionRef as p,isObject as m,parsePackageFiles as h,resolvePointer as g,revalidateDefinition as _,validateInstance as v,validateValue as y}from"./src-BdRgsSfC.js";import{n as b}from"./db-BLFcPcnY.js";import{l as x,n as ee}from"./HostedCardBoard-B0VpAP8d.js";var S={name:`puzzle`,size:24,node:[[`path`,{d:`M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z`,key:`w46dr5`}]]};S.node;var C=s(S),w=e(t(),1),T=[],E=null,D=null,O=0,k=0,A=0,j=new Set,M=null,N=()=>{O++,j.forEach(e=>e())},P=()=>{!M&&typeof BroadcastChannel<`u`&&(M=new BroadcastChannel(`vivic:card-definitions:0.1`),M.onmessage=()=>{F()})};async function F(){if(typeof indexedDB>`u`)return;let e=++k,t=await b();try{let n=await t.loadCardDefinitions(),r=[],i=null;for(let e of n)try{let t=await _(e.definition);if(f(p(t))!==e.key)throw Error(`定义 key 与内容身份不匹配`);r.push({definition:t,enabled:e.enabled===!0})}catch{i=`有卡片定义损坏或不兼容；原始定义仍保留，已有实例显示占位。请重新导入。`}e===k&&(T=r,E=i,N())}finally{t.close()}}var I=async(e,t=()=>!0)=>{let n=await b();try{if(!t())throw Error(`安装会话已失效`);await n.saveCardDefinition(e)}finally{n.close()}};typeof document<`u`&&document.addEventListener(`vivic:data-reset`,()=>{k++,A++,T=[],E=null,D=null,N(),M?.postMessage(`reload`)});var L={ready(){return P(),D??=F().catch(e=>{E=`卡片定义读取失败：${e instanceof Error?e.message:String(e)}`,N()})},subscribe(e){return j.add(e),()=>{j.delete(e)}},snapshot:()=>O,list:()=>T,error:()=>E,resetMemory(){k++,A++,T=[],E=null,D=null,N()},refresh:F,get(e,t=!1){return T.find(n=>f(p(n.definition))===f(e)&&(t||n.enabled))?.definition},async install(e,t,n=()=>!0){let r=await _(e);if(r.hash!==t)throw Error(`包内容发生变化；请重新导入和试跑。`);if(await this.ready(),!n())throw Error(`安装会话已失效`);let i=p(r),a=f(i),o=A;if(T.some(e=>e.definition.manifest.id===i.id&&e.definition.manifest.version===i.version&&e.definition.hash!==i.hash))throw Error(`同 ID/版本存在不同内容；请为新包增加版本号。`);let s={definition:r,enabled:!0},c=T.find(e=>f(p(e.definition))===a);if(await I({key:a,...s},n),!n()){if(c&&o===A)await I({key:a,...c});else{let e=await b();try{await e.deleteCardDefinition(a)}finally{e.close()}}throw k++,Error(`安装会话已取消，定义未安装`)}k++,T=[...T.filter(e=>f(p(e.definition))!==a),s],E=null,N(),M?.postMessage(`reload`)},async setEnabled(e,t){await this.ready();let n=this.get(e,!0);if(!n)throw Error(`找不到定义`);let r=f(e);await I({key:r,definition:n,enabled:t}),k++,T=T.map(e=>f(p(e.definition))===r?{...e,enabled:t}:e),N(),M?.postMessage(`reload`)},async uninstall(e){await this.ready();let t=f(e),n=await b();try{await n.deleteCardDefinition(t)}finally{n.close()}k++,T=T.filter(e=>f(p(e.definition))!==t),N(),M?.postMessage(`reload`)}},R=n();function z({schema:e,value:t,onChange:n,label:r=`参数`,onValidityChange:i}){let[a,o]=(0,w.useState)({}),s=e=>{o(e),i?.(Object.keys(e).length===0)},c=(i,o)=>{let c={...t,[i]:o};try{y(e,c,r);let t={...a};delete t[i],s(t),n(c)}catch(e){s({...a,[i]:e instanceof Error?e.message:String(e)})}};return(0,R.jsxs)(`fieldset`,{className:`space-y-2 nodrag`,"data-extension-form":r,children:[(0,R.jsx)(`legend`,{className:`text-sm font-medium`,children:r}),Object.entries(e.properties??{}).map(([n,r])=>(0,R.jsxs)(`label`,{className:`block text-xs`,children:[(0,R.jsxs)(`span`,{className:`mb-1 block`,children:[r.title??n,e.required?.includes(n)?` *`:``]}),r.enum?(0,R.jsx)(`select`,{className:`vivic-scene-input w-full`,value:String(t[n]??``),onChange:e=>c(n,r.enum.find(t=>String(t)===e.target.value)??``),children:r.enum.map(e=>(0,R.jsx)(`option`,{value:String(e),children:String(e)},String(e)))}):r.type===`boolean`?(0,R.jsx)(`input`,{type:`checkbox`,checked:t[n]===!0,onChange:e=>c(n,e.target.checked)}):r.type===`object`||r.type===`array`?(0,R.jsx)(`textarea`,{"aria-label":r.title??n,className:`vivic-scene-input w-full`,defaultValue:JSON.stringify(t[n]??(r.type===`array`?[]:{}),null,2),onBlur:e=>{try{let t=JSON.parse(e.target.value);c(n,t)}catch{s({...a,[n]:`${n}: JSON 格式错误`})}}},`${n}:${JSON.stringify(t[n])}`):(0,R.jsx)(`input`,{"aria-label":r.title??n,className:`vivic-scene-input w-full`,type:r.type===`string`?`text`:`number`,defaultValue:String(t[n]??``),min:r.minimum,max:r.maximum,step:r.type===`integer`?1:`any`,maxLength:r.maxLength,onBlur:e=>c(n,r.type===`string`?e.target.value:Number(e.target.value))},`${n}:${JSON.stringify(t[n])}`),r.description&&(0,R.jsx)(`span`,{className:`vivic-scene-muted block`,children:r.description})]},n)),Object.entries(a).map(([e,t])=>(0,R.jsx)(`p`,{role:`alert`,className:`text-xs text-red-600`,children:t},e))]})}var te=`{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "title": "卡片标题",
      "maxLength": 80,
      "description": "沿用用户给出的标题；没有标题时使用卡片用途。",
      "minLength": 1
    },
    "context": {
      "type": "string",
      "title": "会议结论",
      "maxLength": 1200,
      "description": "仅整理用户已提供的信息；缺失时留空。",
      "default": ""
    }
  },
  "required": [
    "title"
  ],
  "additionalProperties": false
}
`,ne=`{
  "type": "object",
  "properties": {
    "origin": {
      "type": "string",
      "title": "信息来源",
      "maxLength": 10,
      "description": "user 表示用户输入；demo 表示明确的虚构样例。不支持 live 或第三方事实。",
      "enum": [
        "user",
        "demo"
      ]
    }
  },
  "required": [
    "origin"
  ],
  "additionalProperties": false
}
`,re=`{
  "name": "DEMO · 可交互样例",
  "config": {
    "title": "DEMO · 产品评审行动",
    "context": "结论：先完善新手引导，再进行下一轮评审。以下为虚构会议笔记。"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [
      {
        "id": "demo-flow",
        "title": "补全新手引导文案",
        "owner": "我",
        "due": "下周一",
        "status": "待办",
        "note": ""
      },
      {
        "id": "demo-screen",
        "title": "核对关键页面截图",
        "owner": "同事甲",
        "due": "下周二",
        "status": "受阻",
        "note": "等待新版页面"
      },
      {
        "id": "demo-notes",
        "title": "整理评审问题",
        "owner": "我",
        "due": "",
        "status": "完成",
        "note": ""
      }
    ],
    "note": ""
  }
}
`,ie=`{
  "name": "DEMO · 空行动列表",
  "config": {
    "title": "DEMO · 等待补充",
    "context": "从用户给出的事项开始。"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [],
    "note": ""
  }
}
`,ae=`{
  "name": "DEMO · 长文本与完成状态",
  "config": {
    "title": "DEMO · 较长的跨部门协作计划与关键交付整理",
    "context": "这是边界演示：标题、负责人、截止说明与备注都可能较长，内容应自然换行，保持操作可见。"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [
      {
        "id": "demo-flow",
        "title": "复核跨部门反馈并整理一份能够直接用于评审的完整行动清单，确认每一项的依赖、范围与交付结果。",
        "owner": "示例产品与设计协作负责人",
        "due": "完成评审并确认相关依赖后再确定",
        "status": "完成",
        "note": "这是一段用于检验窄卡片布局、长内容换行和编辑状态的虚构备注。"
      }
    ],
    "note": "演示完成态，不代表真实项目进展。"
  }
}
`,oe=`{
  "formatVersion": "0.1",
  "id": "vivic.office-meeting",
  "version": "1.0.0",
  "name": "会议行动卡",
  "description": "将用户粘贴的会议笔记转为结论和行动项，保留负责人、截止时间原文及待办/进行中/受阻/完成。只使用用户提供的笔记，不查询、不创建真实会议或飞书日程；未提到的信息留空。",
  "renderer": "declarative",
  "host": "0.6",
  "capabilities": []
}
`,se=`{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "title": "行动项",
      "description": "可编辑的本地行动，不会发送给其他人或同步外部服务。",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "title": "条目标识",
            "maxLength": 64,
            "description": "条目内稳定标识；编辑时保留。",
            "minLength": 1
          },
          "title": {
            "type": "string",
            "title": "行动内容",
            "maxLength": 160,
            "description": "用户给出的事项，不添加未经提供的承诺。",
            "minLength": 1
          },
          "owner": {
            "type": "string",
            "title": "负责人",
            "maxLength": 80,
            "description": "未给出时留空。",
            "default": ""
          },
          "due": {
            "type": "string",
            "title": "截止说明",
            "maxLength": 100,
            "description": "保留原文；不是外部日历事实。",
            "default": ""
          },
          "status": {
            "type": "string",
            "title": "状态",
            "maxLength": 10,
            "description": "新行动默认为待办，除非用户明确给出其他状态。",
            "enum": [
              "待办",
              "进行中",
              "受阻",
              "完成"
            ],
            "default": "待办"
          },
          "note": {
            "type": "string",
            "title": "备注",
            "maxLength": 500,
            "description": "用户备注；缺失时留空。",
            "default": ""
          }
        },
        "required": [
          "id",
          "title",
          "status"
        ],
        "additionalProperties": false
      },
      "maxItems": 40,
      "default": []
    },
    "note": {
      "type": "string",
      "title": "整体备注",
      "maxLength": 1000,
      "description": "用户个人备注。",
      "default": ""
    }
  },
  "required": [
    "items"
  ],
  "additionalProperties": false
}
`,ce=`{
  "components": [
    {
      "component": "Header",
      "bind": "/config/title"
    },
    {
      "component": "Badge",
      "label": "来源 user=用户输入 / demo=演示",
      "bind": "/data/origin"
    },
    {
      "component": "KeyValue",
      "label": "会议结论",
      "bind": "/config/context"
    },
    {
      "component": "Table",
      "bind": "/state/items",
      "columns": [
        {
          "label": "行动",
          "field": "title"
        },
        {
          "label": "负责人",
          "field": "owner"
        },
        {
          "label": "截止说明",
          "field": "due"
        },
        {
          "label": "状态",
          "field": "status"
        }
      ]
    },
    {
      "component": "KeyValue",
      "label": "备注",
      "bind": "/state/note"
    },
    {
      "component": "KeyValue",
      "label": "范围",
      "text": "本地整理，未同步外部日历"
    }
  ]
}
`,le=`{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "title": "卡片标题",
      "maxLength": 80,
      "description": "沿用用户给出的标题；没有标题时使用卡片用途。",
      "minLength": 1
    },
    "context": {
      "type": "string",
      "title": "计划说明",
      "maxLength": 1200,
      "description": "仅整理用户已提供的信息；缺失时留空。",
      "default": ""
    }
  },
  "required": [
    "title"
  ],
  "additionalProperties": false
}
`,ue=`{
  "type": "object",
  "properties": {
    "origin": {
      "type": "string",
      "title": "信息来源",
      "maxLength": 10,
      "description": "user 表示用户输入；demo 表示明确的虚构样例。不支持 live 或第三方事实。",
      "enum": [
        "user",
        "demo"
      ]
    }
  },
  "required": [
    "origin"
  ],
  "additionalProperties": false
}
`,de=`{
  "name": "DEMO · 可交互样例",
  "config": {
    "title": "DEMO · 发布准备",
    "context": "先完成评审，再确认交付；以下为虚构演示数据。"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [
      {
        "id": "demo-review",
        "title": "整理评审材料",
        "owner": "我",
        "due": "周四下午",
        "priority": "重点",
        "status": "进行中",
        "note": ""
      },
      {
        "id": "demo-feedback",
        "title": "确认反馈清单",
        "owner": "",
        "due": "",
        "priority": "常规",
        "status": "待办",
        "note": "等待评审后补充"
      },
      {
        "id": "demo-release",
        "title": "检查发布说明",
        "owner": "我",
        "due": "周五",
        "priority": "常规",
        "status": "完成",
        "note": ""
      }
    ],
    "note": ""
  }
}
`,B=`{
  "name": "DEMO · 空行动列表",
  "config": {
    "title": "DEMO · 等待补充",
    "context": "从用户给出的事项开始。"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [],
    "note": ""
  }
}
`,V=`{
  "name": "DEMO · 长文本与完成状态",
  "config": {
    "title": "DEMO · 较长的跨部门协作计划与关键交付整理",
    "context": "这是边界演示：标题、负责人、截止说明与备注都可能较长，内容应自然换行，保持操作可见。"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [
      {
        "id": "demo-review",
        "title": "复核跨部门反馈并整理一份能够直接用于评审的完整行动清单，确认每一项的依赖、范围与交付结果。",
        "owner": "示例产品与设计协作负责人",
        "due": "完成评审并确认相关依赖后再确定",
        "priority": "重点",
        "status": "完成",
        "note": "这是一段用于检验窄卡片布局、长内容换行和编辑状态的虚构备注。"
      }
    ],
    "note": "演示完成态，不代表真实项目进展。"
  }
}
`,H=`{
  "formatVersion": "0.1",
  "id": "vivic.office-tasks",
  "version": "1.0.0",
  "name": "工作推进卡",
  "description": "把用户提供的工作事项整理为可编辑任务，支持负责人、原文截止说明、优先级、受阻与完成状态。用于工作推进/项目任务，不替代已有目标进度卡。只整理用户事实；缺失负责人和截止说明留空，不编造飞书任务或真实日程。",
  "renderer": "declarative",
  "host": "0.6",
  "capabilities": []
}
`,fe=`{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "title": "行动项",
      "description": "可编辑的本地行动，不会发送给其他人或同步外部服务。",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "title": "条目标识",
            "maxLength": 64,
            "description": "条目内稳定标识；编辑时保留。",
            "minLength": 1
          },
          "title": {
            "type": "string",
            "title": "行动内容",
            "maxLength": 160,
            "description": "用户给出的事项，不添加未经提供的承诺。",
            "minLength": 1
          },
          "owner": {
            "type": "string",
            "title": "负责人",
            "maxLength": 80,
            "description": "未给出时留空。",
            "default": ""
          },
          "due": {
            "type": "string",
            "title": "截止说明",
            "maxLength": 100,
            "description": "保留原文；不是外部日历事实。",
            "default": ""
          },
          "status": {
            "type": "string",
            "title": "状态",
            "maxLength": 10,
            "description": "新行动默认为待办，除非用户明确给出其他状态。",
            "enum": [
              "待办",
              "进行中",
              "受阻",
              "完成"
            ],
            "default": "待办"
          },
          "note": {
            "type": "string",
            "title": "备注",
            "maxLength": 500,
            "description": "用户备注；缺失时留空。",
            "default": ""
          },
          "priority": {
            "type": "string",
            "title": "优先级",
            "maxLength": 10,
            "description": "用户没有说明时使用常规。",
            "enum": [
              "重点",
              "常规",
              "稍后"
            ],
            "default": "常规"
          }
        },
        "required": [
          "id",
          "title",
          "status"
        ],
        "additionalProperties": false
      },
      "maxItems": 40,
      "default": []
    },
    "note": {
      "type": "string",
      "title": "整体备注",
      "maxLength": 1000,
      "description": "用户个人备注。",
      "default": ""
    }
  },
  "required": [
    "items"
  ],
  "additionalProperties": false
}
`,pe=`{
  "components": [
    {
      "component": "Header",
      "bind": "/config/title"
    },
    {
      "component": "Badge",
      "label": "来源 user=用户输入 / demo=演示",
      "bind": "/data/origin"
    },
    {
      "component": "KeyValue",
      "label": "计划说明",
      "bind": "/config/context"
    },
    {
      "component": "Table",
      "bind": "/state/items",
      "columns": [
        {
          "label": "行动",
          "field": "title"
        },
        {
          "label": "负责人",
          "field": "owner"
        },
        {
          "label": "截止说明",
          "field": "due"
        },
        {
          "label": "状态",
          "field": "status"
        }
      ]
    },
    {
      "component": "KeyValue",
      "label": "备注",
      "bind": "/state/note"
    },
    {
      "component": "KeyValue",
      "label": "范围",
      "text": "本地整理，未同步外部日历"
    }
  ]
}
`,me=`{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "title": "卡片标题",
      "maxLength": 80,
      "description": "沿用用户给出的标题；没有标题时使用卡片用途。",
      "minLength": 1
    },
    "context": {
      "type": "string",
      "title": "计划说明",
      "maxLength": 1200,
      "description": "仅整理用户已提供的信息；缺失时留空。",
      "default": ""
    },
    "period": {
      "type": "string",
      "title": "计划周期",
      "maxLength": 80,
      "description": "保留用户原文，如本周/下周，不猜具体日期。",
      "default": ""
    }
  },
  "required": [
    "title"
  ],
  "additionalProperties": false
}
`,he=`{
  "type": "object",
  "properties": {
    "origin": {
      "type": "string",
      "title": "信息来源",
      "maxLength": 10,
      "description": "user 表示用户输入；demo 表示明确的虚构样例。不支持 live 或第三方事实。",
      "enum": [
        "user",
        "demo"
      ]
    }
  },
  "required": [
    "origin"
  ],
  "additionalProperties": false
}
`,ge=`{
  "name": "DEMO · 可交互样例",
  "config": {
    "title": "DEMO · 本周重点",
    "context": "本周只推进三件关键事项；以下为虚构演示计划。",
    "period": "本周"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [
      {
        "id": "demo-outline",
        "title": "完成方案大纲",
        "day": "周一",
        "owner": "我",
        "due": "",
        "status": "完成",
        "note": ""
      },
      {
        "id": "demo-review",
        "title": "评审交互稿",
        "day": "周三",
        "owner": "",
        "due": "",
        "status": "进行中",
        "note": ""
      },
      {
        "id": "demo-wrap",
        "title": "整理周回顾",
        "day": "周五",
        "owner": "我",
        "due": "",
        "status": "待办",
        "note": ""
      }
    ],
    "note": ""
  }
}
`,_e=`{
  "name": "DEMO · 空行动列表",
  "config": {
    "title": "DEMO · 等待补充",
    "context": "从用户给出的事项开始。",
    "period": ""
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [],
    "note": ""
  }
}
`,ve=`{
  "name": "DEMO · 长文本与完成状态",
  "config": {
    "title": "DEMO · 较长的跨部门协作计划与关键交付整理",
    "context": "这是边界演示：标题、负责人、截止说明与备注都可能较长，内容应自然换行，保持操作可见。",
    "period": "本周"
  },
  "data": {
    "origin": "demo"
  },
  "state": {
    "items": [
      {
        "id": "demo-outline",
        "title": "复核跨部门反馈并整理一份能够直接用于评审的完整行动清单，确认每一项的依赖、范围与交付结果。",
        "day": "周一",
        "owner": "示例产品与设计协作负责人",
        "due": "完成评审并确认相关依赖后再确定",
        "status": "完成",
        "note": "这是一段用于检验窄卡片布局、长内容换行和编辑状态的虚构备注。"
      }
    ],
    "note": "演示完成态，不代表真实项目进展。"
  }
}
`,ye=`{
  "formatVersion": "0.1",
  "id": "vivic.office-week",
  "version": "1.0.0",
  "name": "每周重点卡",
  "description": "将用户给出的周计划整理成按星期分组的重点行动，支持未安排、截止说明和完成状态。它是个人计划，不是已确认的会议日程；不推测具体日期、时刻或飞书空闲情况，未提供内容留空。",
  "renderer": "declarative",
  "host": "0.6",
  "capabilities": []
}
`,U=`{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "title": "行动项",
      "description": "可编辑的本地行动，不会发送给其他人或同步外部服务。",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "title": "条目标识",
            "maxLength": 64,
            "description": "条目内稳定标识；编辑时保留。",
            "minLength": 1
          },
          "title": {
            "type": "string",
            "title": "行动内容",
            "maxLength": 160,
            "description": "用户给出的事项，不添加未经提供的承诺。",
            "minLength": 1
          },
          "owner": {
            "type": "string",
            "title": "负责人",
            "maxLength": 80,
            "description": "未给出时留空。",
            "default": ""
          },
          "due": {
            "type": "string",
            "title": "截止说明",
            "maxLength": 100,
            "description": "保留原文；不是外部日历事实。",
            "default": ""
          },
          "status": {
            "type": "string",
            "title": "状态",
            "maxLength": 10,
            "description": "新行动默认为待办，除非用户明确给出其他状态。",
            "enum": [
              "待办",
              "进行中",
              "受阻",
              "完成"
            ],
            "default": "待办"
          },
          "note": {
            "type": "string",
            "title": "备注",
            "maxLength": 500,
            "description": "用户备注；缺失时留空。",
            "default": ""
          },
          "day": {
            "type": "string",
            "title": "星期",
            "maxLength": 10,
            "description": "仅使用用户指定星期；未给出时使用待安排。",
            "enum": [
              "周一",
              "周二",
              "周三",
              "周四",
              "周五",
              "周六",
              "周日",
              "待安排"
            ],
            "default": "待安排"
          }
        },
        "required": [
          "id",
          "title",
          "status"
        ],
        "additionalProperties": false
      },
      "maxItems": 40,
      "default": []
    },
    "note": {
      "type": "string",
      "title": "整体备注",
      "maxLength": 1000,
      "description": "用户个人备注。",
      "default": ""
    }
  },
  "required": [
    "items"
  ],
  "additionalProperties": false
}
`,be=`{
  "components": [
    {
      "component": "Header",
      "bind": "/config/title"
    },
    {
      "component": "Badge",
      "label": "来源 user=用户输入 / demo=演示",
      "bind": "/data/origin"
    },
    {
      "component": "KeyValue",
      "label": "计划周期",
      "bind": "/config/period"
    },
    {
      "component": "KeyValue",
      "label": "计划说明",
      "bind": "/config/context"
    },
    {
      "component": "Table",
      "bind": "/state/items",
      "columns": [
        {
          "label": "行动",
          "field": "title"
        },
        {
          "label": "星期",
          "field": "day"
        },
        {
          "label": "负责人",
          "field": "owner"
        },
        {
          "label": "截止说明",
          "field": "due"
        },
        {
          "label": "状态",
          "field": "status"
        }
      ]
    },
    {
      "component": "KeyValue",
      "label": "备注",
      "bind": "/state/note"
    },
    {
      "component": "KeyValue",
      "label": "范围",
      "text": "本地整理，未同步外部日历"
    }
  ]
}
`,W=[{kind:`tasks`,id:`vivic.office-tasks`,name:`工作推进卡`,description:`把工作拆成行动，记录负责人、优先级和进展。`,prompt:`用工作推进卡整理发布准备：我负责整理评审材料，周四下午截止，正在进行；确认反馈清单，待办；检查发布说明，周五截止。`},{kind:`meeting`,id:`vivic.office-meeting`,name:`会议行动卡`,description:`从会议笔记提取结论与后续行动。`,prompt:`用会议行动卡整理这些笔记：结论是先完善新手引导。我负责补全文案，下周一截止；同事甲核对截图，下周二截止，正在等待新版页面。`},{kind:`week`,id:`vivic.office-week`,name:`每周重点卡`,description:`按星期安排重点，清楚看到完成与待推进。`,prompt:`用每周重点卡整理本周：周一完成方案大纲，已经完成；周三评审交互稿，正在进行；周五整理周回顾，待办。`}],xe=Object.assign({"../../../../../examples/card-packages/office-meeting/config.schema.json":te,"../../../../../examples/card-packages/office-meeting/data.schema.json":ne,"../../../../../examples/card-packages/office-meeting/examples/default.json":re,"../../../../../examples/card-packages/office-meeting/examples/empty.json":ie,"../../../../../examples/card-packages/office-meeting/examples/long.json":ae,"../../../../../examples/card-packages/office-meeting/manifest.json":oe,"../../../../../examples/card-packages/office-meeting/state.schema.json":se,"../../../../../examples/card-packages/office-meeting/ui.json":ce,"../../../../../examples/card-packages/office-tasks/config.schema.json":le,"../../../../../examples/card-packages/office-tasks/data.schema.json":ue,"../../../../../examples/card-packages/office-tasks/examples/default.json":de,"../../../../../examples/card-packages/office-tasks/examples/empty.json":B,"../../../../../examples/card-packages/office-tasks/examples/long.json":V,"../../../../../examples/card-packages/office-tasks/manifest.json":H,"../../../../../examples/card-packages/office-tasks/state.schema.json":fe,"../../../../../examples/card-packages/office-tasks/ui.json":pe,"../../../../../examples/card-packages/office-week/config.schema.json":me,"../../../../../examples/card-packages/office-week/data.schema.json":he,"../../../../../examples/card-packages/office-week/examples/default.json":ge,"../../../../../examples/card-packages/office-week/examples/empty.json":_e,"../../../../../examples/card-packages/office-week/examples/long.json":ve,"../../../../../examples/card-packages/office-week/manifest.json":ye,"../../../../../examples/card-packages/office-week/state.schema.json":U,"../../../../../examples/card-packages/office-week/ui.json":be}),G,K=[];function Se(){return G??=Promise.all(W.map(async e=>{let t=`/office-${e.kind}/`,n=Object.fromEntries(Object.entries(xe).filter(([e])=>e.includes(t)).map(([e,n])=>[e.slice(e.indexOf(t)+t.length),n])),r=await h(n);if(r.manifest.id!==e.id)throw Error(`办公卡片目录与包身份不一致`);return r})).then(e=>(K=e,e)),G}function q(e){if(!e)return;let t=K.findIndex(t=>f(p(t))===f(p(e)));return t<0?void 0:W[t]?.kind}var J=[`待办`,`进行中`,`受阻`,`完成`],Y=[`周一`,`周二`,`周三`,`周四`,`周五`,`周六`,`周日`,`待安排`],X=e=>typeof e==`string`?e:``;function Ce(e){if(!Array.isArray(e.items))throw Error(`行动项需要列表`);return e.items.map(e=>{if(!m(e)||typeof e.id!=`string`||typeof e.title!=`string`||!J.some(t=>t===e.status))throw Error(`行动项格式不正确`);let t=J.find(t=>t===e.status);return{id:e.id,title:e.title,status:t,...Object.fromEntries([`owner`,`due`,`note`,`priority`,`day`].filter(t=>typeof e[t]==`string`).map(t=>[t,e[t]]))}})}function we({card:e,height:t,definition:n,kind:r,preview:s=!1}){let u=x(e),[f,p]=(0,w.useState)(null),[m,h]=(0,w.useState)(!1),[g,_]=(0,w.useState)(null),[y,b]=(0,w.useState)(null),S=(0,w.useRef)(null),C=e.displayProps,T=[],E;try{if(q(n)!==r||n.hash!==C.def.hash||n.manifest.id!==C.def.id||n.manifest.version!==C.def.version)throw Error(`卡片定义与办公视图不匹配`);v(n,C),T=Ce(C.state)}catch(e){E=e instanceof Error?e.message:`卡片数据不可用`}let D={config:C.config,state:C.state},O=y!==null&&y.after===d(D),k=(e,t=!0)=>{if(!u.editable)return!1;try{v(n,{...C,...e})}catch(e){return _(e instanceof Error?e.message:`内容未通过校验`),!1}return u.patch(e)?(_(null),b(t?{before:structuredClone(D),after:d(e)}:null),!0):(_(`没有保存。请确认主窗口仍可编辑，然后重试。`),!1)},A=e=>k({config:C.config,state:{...C.state,items:e}}),j=T.filter(e=>e.status===`完成`).length,M=T.filter(e=>e.status===`受阻`).length,N=T.length?Math.round(j/T.length*100):0,P=s||C.data.origin===`demo`,F=r===`meeting`?`file`:r===`week`?`calendar`:`list`,I=r===`week`?Y.map(e=>({label:e,entries:T.map((e,t)=>({item:e,index:t})).filter(({item:t})=>(t.day||`待安排`)===e)})).filter(e=>e.entries.length):[{label:``,entries:T.map((e,t)=>({item:e,index:t}))}],L=X(C.config.title)||n.manifest.name;return(0,R.jsx)(c,{card:e,height:t,title:L,kicker:n.manifest.name,harkIcon:F,badge:P?`DEMO · 虚构样例`:`用户输入`,badgeTone:P?`caution`:`neutral`,meta:r===`week`?X(C.config.period):void 0,footer:(0,R.jsxs)(R.Fragment,{children:[(0,R.jsx)(`span`,{children:`Space 内整理，未同步外部日历`}),u.editable&&O&&(0,R.jsxs)(`button`,{type:`button`,className:`vivic-scene-action nodrag nopan`,onClick:()=>{y&&k(y.before,!1)},children:[(0,R.jsx)(i,{name:`refresh`,size:13,"aria-hidden":!0}),`撤销上次编辑`]})]}),className:`vivic-office vh-hark`,children:E?(0,R.jsx)(l,{children:E}):(0,R.jsxs)(`div`,{className:`vivic-office-content`,"data-office-planner":r,"data-extension-rendered":n.manifest.id,"data-hark-card":`action-list`,children:[X(C.config.context)&&(0,R.jsx)(`p`,{className:`vivic-office-context`,children:X(C.config.context)}),(0,R.jsxs)(`div`,{className:`vivic-office-progress`,children:[(0,R.jsxs)(`span`,{children:[(0,R.jsx)(`strong`,{children:j}),` / `,T.length,` 已完成`]}),M>0&&(0,R.jsxs)(`span`,{className:`vivic-office-blocked`,children:[M,` 项受阻`]}),(0,R.jsx)(`progress`,{max:100,value:N,"aria-label":`行动完成比例`})]}),(0,R.jsxs)(`div`,{className:`vivic-office-list${t===void 0?``:` vivic-scene-scroll nowheel`}`,children:[!T.length&&(0,R.jsx)(l,{children:r===`meeting`?`还没有行动项。先补充会议笔记中的下一步。`:`还没有行动项。先添加一件要推进的事。`}),I.map(e=>(0,R.jsxs)(`section`,{className:`vivic-office-group`,children:[e.label&&(0,R.jsxs)(`h4`,{className:`vivic-office-day`,children:[e.label,(0,R.jsx)(`span`,{children:e.entries.length})]}),e.entries.map(({item:e,index:t})=>(0,R.jsxs)(a,{as:`article`,className:`vivic-office-row`,"data-office-item":e.id,"data-status":e.status,children:[u.editable?(0,R.jsx)(`button`,{type:`button`,className:`vivic-office-check nodrag nopan`,role:`checkbox`,"aria-checked":e.status===`完成`,"aria-label":`${e.title}：标记${e.status===`完成`?`未完成`:`完成`}`,onClick:()=>A(T.map((e,n)=>n===t?{...e,status:e.status===`完成`?`待办`:`完成`}:e)),children:(0,R.jsx)(i,{name:`check`,size:13,"aria-hidden":!0})}):(0,R.jsx)(`span`,{className:`vivic-office-check`,"aria-label":e.status===`完成`?`已完成`:e.status,children:(0,R.jsx)(i,{name:`check`,size:13,"aria-hidden":!0})}),(0,R.jsxs)(`div`,{className:`vivic-office-row-body`,children:[(0,R.jsx)(`h3`,{className:`vivic-office-item-title`,children:e.title}),(0,R.jsxs)(`div`,{className:`vivic-office-row-meta`,children:[e.owner&&(0,R.jsx)(`span`,{children:e.owner}),e.due&&(0,R.jsxs)(`span`,{children:[`截止：`,e.due]}),e.priority===`重点`&&(0,R.jsx)(`span`,{className:`vivic-office-priority`,children:`重点`}),(0,R.jsx)(`span`,{className:`vivic-office-status`,children:e.status})]}),e.note&&(0,R.jsx)(`p`,{className:`vivic-office-note`,children:e.note})]}),u.editable&&(0,R.jsx)(`button`,{type:`button`,className:`vivic-scene-icon-button nodrag nopan`,"aria-label":`编辑：${e.title}`,onClick:e=>{S.current=e.currentTarget,p(t),h(!1),_(null)},children:(0,R.jsx)(i,{name:`edit`,size:14,"aria-hidden":!0})})]},`${t}:${e.id}`))]},e.label||`all`))]}),X(C.state.note)&&(0,R.jsxs)(`p`,{className:`vivic-office-note`,children:[`备注：`,X(C.state.note)]}),u.editable&&(0,R.jsxs)(`div`,{className:`vivic-office-toolbar nodrag nopan`,children:[(0,R.jsxs)(`button`,{type:`button`,className:`vivic-scene-action`,disabled:T.length>=40,onClick:e=>{S.current=e.currentTarget,p(`new`),h(!1),_(null)},children:[(0,R.jsx)(i,{name:`add`,size:14,"aria-hidden":!0}),`添加行动`]}),(0,R.jsxs)(`button`,{type:`button`,className:`vivic-scene-action`,onClick:e=>{S.current=e.currentTarget,h(e=>!e),p(null),_(null)},children:[(0,R.jsx)(i,{name:`edit`,size:13,"aria-hidden":!0}),`编辑参数`]})]}),(0,R.jsx)(o,{open:u.editable&&(f!==null||m),onOpenChange:e=>{e||(p(null),h(!1),_(null))},children:(f!==null||m)&&(0,R.jsx)(ee,{title:m?`编辑卡片参数`:f===`new`?`添加行动`:`编辑行动`,description:`保存后更新当前卡片；取消会保留原有内容。`,className:`vivic-office-editor`,onCloseAutoFocus:e=>{e.preventDefault(),S.current?.isConnected&&S.current.focus()},children:(0,R.jsxs)(`div`,{className:`vivic-office-editor-body`,children:[u.editable&&f!==null&&(0,R.jsx)(Te,{kind:r,item:f===`new`?void 0:T[f],onCancel:()=>p(null),onRemove:f===`new`?void 0:()=>{A(T.filter((e,t)=>t!==f))&&p(null)},onSave:e=>{let t=new Set(T.map(e=>e.id)),n=T.length+1;for(;t.has(`action-${n}`);)n+=1;let r=f===`new`?[...T,{...e,id:`action-${n}`}]:T.map((t,n)=>n===f?{...t,...e,id:t.id}:t);A(r)&&p(null)}},`${f}:${f===`new`?`new`:d(T[f]??{})}`),u.editable&&m&&(0,R.jsx)(Ee,{kind:r,value:D,onCancel:()=>h(!1),onSave:e=>{k(e)&&h(!1)}},d(D)),g&&(0,R.jsx)(`p`,{role:`alert`,className:`vivic-office-error`,children:g})]})})}),g&&f===null&&!m&&(0,R.jsx)(`p`,{role:`alert`,className:`vivic-office-error`,children:g})]})})}function Te({kind:e,item:t,onSave:n,onCancel:r,onRemove:a}){return(0,R.jsxs)(`form`,{onSubmit:r=>{r.preventDefault();let i=new FormData(r.currentTarget),a=e=>X(i.get(e)).trim(),o=a(`title`);if(!o)return;let s=J.find(e=>e===a(`status`))??`待办`;n({id:t?.id??`new`,title:o,owner:a(`owner`),due:a(`due`),note:a(`note`),status:s,...e===`tasks`?{priority:a(`priority`)}:{},...e===`week`?{day:a(`day`)}:{}})},className:`vivic-office-form nodrag nopan`,"aria-label":t?`编辑行动`:`添加行动`,children:[(0,R.jsx)(Z,{label:`行动内容`,children:(0,R.jsx)(`input`,{name:`title`,"aria-label":`行动内容`,defaultValue:t?.title??``,maxLength:160,required:!0,className:`vivic-scene-input`})}),(0,R.jsxs)(`div`,{className:`vivic-office-fields`,children:[(0,R.jsx)(Z,{label:`负责人`,children:(0,R.jsx)(`input`,{name:`owner`,"aria-label":`负责人`,defaultValue:t?.owner??``,maxLength:80,placeholder:`未指定`,className:`vivic-scene-input`})}),(0,R.jsx)(Z,{label:`截止说明`,children:(0,R.jsx)(`input`,{name:`due`,"aria-label":`截止说明`,defaultValue:t?.due??``,maxLength:100,placeholder:`保留原文，如周五下午`,className:`vivic-scene-input`})})]}),(0,R.jsxs)(`div`,{className:`vivic-office-fields`,children:[(0,R.jsx)(Z,{label:`状态`,children:(0,R.jsx)(`select`,{name:`status`,"aria-label":`状态`,defaultValue:t?.status??`待办`,className:`vivic-scene-input`,children:J.map(e=>(0,R.jsx)(`option`,{children:e},e))})}),e===`tasks`&&(0,R.jsx)(Z,{label:`优先级`,children:(0,R.jsx)(`select`,{name:`priority`,"aria-label":`优先级`,defaultValue:t?.priority??`常规`,className:`vivic-scene-input`,children:[`重点`,`常规`,`稍后`].map(e=>(0,R.jsx)(`option`,{children:e},e))})}),e===`week`&&(0,R.jsx)(Z,{label:`星期`,children:(0,R.jsx)(`select`,{name:`day`,"aria-label":`星期`,defaultValue:t?.day??`待安排`,className:`vivic-scene-input`,children:Y.map(e=>(0,R.jsx)(`option`,{children:e},e))})})]}),(0,R.jsx)(Z,{label:`行动备注`,children:(0,R.jsx)(`textarea`,{name:`note`,"aria-label":`行动备注`,defaultValue:t?.note??``,maxLength:500,className:`vivic-scene-input`,rows:2})}),(0,R.jsxs)(`div`,{className:`vivic-office-form-actions`,children:[(0,R.jsxs)(`button`,{type:`submit`,className:`vivic-scene-action`,children:[(0,R.jsx)(i,{name:`check`,size:14,"aria-hidden":!0}),`保存行动`]}),(0,R.jsxs)(`button`,{type:`button`,className:`vivic-scene-action`,onClick:r,children:[(0,R.jsx)(i,{name:`close`,size:14,"aria-hidden":!0}),`取消`]}),a&&(0,R.jsx)(`button`,{type:`button`,className:`vivic-scene-action vivic-office-remove`,onClick:a,children:`删除行动`})]})]})}function Z({label:e,children:t}){return(0,R.jsxs)(`label`,{className:`vivic-office-field`,children:[(0,R.jsx)(`span`,{children:e}),t]})}function Ee({kind:e,value:t,onSave:n,onCancel:r}){return(0,R.jsxs)(`form`,{className:`vivic-office-form nodrag nopan`,"aria-label":`编辑卡片参数`,onSubmit:r=>{r.preventDefault();let i=new FormData(r.currentTarget),a=e=>X(i.get(e)).trim();a(`title`)&&n({config:{...t.config,title:a(`title`),context:a(`context`),...e===`week`?{period:a(`period`)}:{}},state:{...t.state,note:a(`note`)}})},children:[(0,R.jsx)(Z,{label:`卡片标题`,children:(0,R.jsx)(`input`,{name:`title`,"aria-label":`卡片标题`,className:`vivic-scene-input`,defaultValue:X(t.config.title),required:!0,maxLength:80})}),e===`week`&&(0,R.jsx)(Z,{label:`计划周期`,children:(0,R.jsx)(`input`,{name:`period`,"aria-label":`计划周期`,className:`vivic-scene-input`,defaultValue:X(t.config.period),maxLength:80})}),(0,R.jsx)(Z,{label:e===`meeting`?`会议结论`:`计划说明`,children:(0,R.jsx)(`textarea`,{name:`context`,"aria-label":e===`meeting`?`会议结论`:`计划说明`,className:`vivic-scene-input`,defaultValue:X(t.config.context),rows:3,maxLength:1200})}),(0,R.jsx)(Z,{label:`整体备注`,children:(0,R.jsx)(`textarea`,{name:`note`,"aria-label":`整体备注`,className:`vivic-scene-input`,defaultValue:X(t.state.note),rows:2,maxLength:1e3})}),(0,R.jsxs)(`div`,{className:`vivic-office-form-actions`,children:[(0,R.jsx)(`button`,{type:`submit`,className:`vivic-scene-action`,children:`保存参数`}),(0,R.jsx)(`button`,{type:`button`,className:`vivic-scene-action`,onClick:r,children:`取消`})]})]})}function De(e){let[,t]=(0,w.useState)(0);return(0,w.useEffect)(()=>{let e=!0;return Se().then(()=>{e&&t(e=>e+1)}).catch(()=>{}),()=>{e=!1}},[]),q(e)}var Q=e=>e==null?`—`:typeof e==`object`?JSON.stringify(e):String(e),$=e=>{if(typeof e!=`string`)return null;try{let t=new URL(e);return t.protocol===`https:`&&!t.username&&!t.password?t.href:null}catch{return null}};function Oe({block:e,root:t,allowNetwork:n}){let r=e.bind?g(t,e.bind):e.text,i=Q(r),a=e.label;switch(e.component){case`Header`:return(0,R.jsx)(`h4`,{className:`text-lg font-semibold break-words`,children:i});case`Metric`:return(0,R.jsxs)(`div`,{children:[(0,R.jsx)(`p`,{className:`vivic-scene-muted text-xs`,children:a}),(0,R.jsx)(`strong`,{className:`text-3xl tabular-nums break-words`,children:i})]});case`KeyValue`:return(0,R.jsxs)(`div`,{className:`flex justify-between gap-3 text-sm`,children:[(0,R.jsx)(`span`,{className:`vivic-scene-muted max-w-[40%] shrink-0 truncate`,title:a,children:a}),(0,R.jsx)(`span`,{className:`min-w-0 break-words text-right`,children:i})]});case`Badge`:return(0,R.jsxs)(`span`,{className:`vivic-scene-badge`,children:[a?`${a} · `:``,i]});case`List`:return Array.isArray(r)&&r.length?(0,R.jsx)(`ul`,{className:`space-y-2 text-sm list-disc pl-4`,children:r.map((e,t)=>(0,R.jsx)(`li`,{className:`break-words`,children:Q(e)},t))}):(0,R.jsx)(l,{children:`暂无内容`});case`Image`:{if(!n)return(0,R.jsxs)(l,{children:[a??`图片`,` · DEMO 预览不加载远程图片`]});let e=$(r);return e?(0,R.jsx)(u,{className:`vivic-extension-image`,src:e,alt:a??`卡片图片`,fit:`contain`}):(0,R.jsx)(l,{children:a??`图片不可用`})}case`Link`:{let e=$(r);return e&&n?(0,R.jsx)(`a`,{className:`vivic-scene-action break-all`,href:e,target:`_blank`,rel:`noopener noreferrer`,children:a??e}):(0,R.jsxs)(`span`,{className:`vivic-scene-muted text-xs`,children:[a??`链接`,n?`不可用`:` · DEMO 链接未打开`]})}case`Progress`:{let e=typeof r==`number`?Math.min(100,Math.max(0,r)):0;return(0,R.jsxs)(`div`,{className:`space-y-1`,children:[(0,R.jsxs)(`p`,{className:`text-xs`,children:[a,` `,e,`%`]}),(0,R.jsx)(`progress`,{className:`vivic-extension-progress w-full`,style:{accentColor:`var(--vivic-accent, #7c68df)`},max:100,value:e,"aria-label":a??`进度`})]})}case`Table`:return Array.isArray(r)&&r.length?(0,R.jsx)(`div`,{className:`vivic-extension-table`,tabIndex:0,role:`region`,"aria-label":a??`卡片数据表`,children:(0,R.jsxs)(`table`,{className:`w-full text-xs`,children:[(0,R.jsx)(`thead`,{children:(0,R.jsx)(`tr`,{children:e.columns?.map(e=>(0,R.jsx)(`th`,{scope:`col`,className:`p-2 text-left`,children:e.label},e.field))})}),(0,R.jsx)(`tbody`,{children:r.map((t,n)=>(0,R.jsx)(`tr`,{children:e.columns?.map(e=>(0,R.jsx)(`td`,{className:`p-2 break-words border-t border-[var(--border)]`,children:Q(typeof t==`object`&&t&&Object.hasOwn(t,e.field)?t[e.field]:void 0)},e.field))},n))})]})}):(0,R.jsx)(l,{children:`暂无数据`})}}function ke({card:e,height:t,definition:n}){let i=(0,w.useContext)(r);(0,w.useSyncExternalStore)(L.subscribe,L.snapshot,L.snapshot),(0,w.useEffect)(()=>{!n&&!i&&L.ready()},[n,i]);let a=x(e),o=n??(i?i.get(e.displayProps.def):L.get(e.displayProps.def)),s=De(o),u=o?null:i?.loading?`正在读取空间卡片定义…`:i?.error??`卡片定义缺失或已禁用。在设置重新导入原包或启用即可恢复；原始卡片数据已保留。`;if(o)try{v(o,e.displayProps)}catch(e){u=e instanceof Error?e.message:String(e)}return!u&&o&&s?(0,R.jsx)(we,{card:e,height:t,definition:o,kind:s,preview:!!n}):(0,R.jsx)(c,{card:e,height:t,icon:C,harkIcon:`apps`,kicker:`扩展卡片`,title:o?.manifest.name??e.displayProps.def.id,badge:u?`暂不可用`:n?`DEMO`:`v${o?.manifest.version}`,badgeTone:u?`caution`:`accent`,footer:u?void 0:(0,R.jsx)(`span`,{children:n?`预览`:i?`空间卡片包`:`本地卡片包`}),children:u?(0,R.jsx)(l,{children:u}):(0,R.jsxs)(`div`,{className:`vivic-extension-content space-y-4${t===void 0?``:` vivic-scene-scroll nowheel`}`,"data-extension-rendered":e.displayProps.def.id,children:[o.ui.components.map((t,r)=>(0,R.jsx)(Oe,{block:t,root:e.displayProps,allowNetwork:!n},r)),a.editable&&(0,R.jsxs)(`details`,{children:[(0,R.jsx)(`summary`,{className:`vivic-scene-action cursor-pointer`,children:`编辑参数和个人状态`}),(0,R.jsxs)(`div`,{className:`space-y-4 mt-3`,children:[(0,R.jsx)(z,{schema:o.configSchema,value:e.displayProps.config,onChange:e=>{a.patch({config:e})}}),(0,R.jsx)(z,{label:`个人状态`,schema:o.stateSchema,value:e.displayProps.state,onChange:e=>{a.patch({state:e})}})]})]})]})})}export{ke as ExtensionCardView};