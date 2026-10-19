/* ============================================================
 * 小组作业工作台 · 默认预设（config.js）
 * ------------------------------------------------------------
 * 这个文件是「初始化向导」的预填值：第一个打开工作台的人会
 * 在向导里看到这些默认值，可随意修改（模块开关、任务分类、
 * 资料分类、管理员称呼、成员与管理员都在向导里定）。
 *
 * 向导里选好的设置会保存到服务端（state.settings），之后以
 * 服务端为准，本文件不再起作用（除非后端没存 settings）。
 *
 * 如果你想让模板开箱就有你的默认值（比如固定叫"XX课程小组"），
 * 改这里即可；key 只能用英文、数字或短横线。
 * ============================================================ */
const WB_CONFIG = {

  /* 项目名称与称呼 */
  title: '小组作业工作台',
  subtitle: 'Group Workbench',
  adminLabel: '组长',        // 管理员的显示称呼，如：组长 / 队长 / 负责人

  /* 权限预设：'admin' 仅管理员可用 / 'all' 所有成员可用（向导第 3 步可逐项调整） */
  perms: {
    createTask: 'admin',    deleteTask: 'admin',   assignTask: 'admin',
    markRework: 'admin',    markDone: 'admin',     announce: 'admin',
    resolveReview: 'admin', adoptLit: 'admin',
    memberManage: 'admin',  backup: 'admin'
  },

  /* 可选功能模块预填（向导里可勾选/取消；总览、任务看板、使用说明是常驻核心） */
  modules: {
    resources:     { name: '资料库',   icon: '◈',  on: true  },
    announcements: { name: '公告区',   icon: '◇',  on: true  },
    lits:          { name: '文献汇总', icon: '📚', on: true  },
    reviews:       { name: '审议意见', icon: '✎',  on: true  }
  },

  /* 任务分类预设：key → 显示名 */
  lines: {
    writing: '文案写作',
    design:  '设计制作',
    other:   '其他'
  },

  /* 资料库分类预设：key → { name 显示名, icon 图标 } */
  resCats: {
    lit:   { name: '文献资料', icon: '📚' },
    media: { name: '影像素材', icon: '🎬' },
    ref:   { name: '参考文件', icon: '📄' },
    other: { name: '其他',     icon: '◈'  }
  }
};
