# 在线考试系统 - Premium v1.0

## 项目概述

完整构建了一套**在线考试系统**，包含考生端和管理端，支持题目导入、自动评分、成绩统计分析。

## 技术架构

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| **后端** | Node.js + Express | RESTful API，JWT认证 |
| **数据库** | SQLite (sql.js) | 零配置，文件存储，支持50+并发 |
| **前端** | 原生 HTML/CSS/JS | Glass Morphism 设计，主题切换 |
| **认证** | JWT (Bearer Token) | 24小时过期，角色权限控制 |

## 数据库设计 (5张核心表)

- `users` - 用户表（角色：student/admin）
- `exams` - 考试表（标题/时长/总分/及格线/状态）
- `questions` - 题目表（4种题型：单选/多选/判断/简答）
- `submissions` - 提交记录表
- `answers` - 答题明细表

## 功能清单

### 考生端 (http://localhost:3000)
- [x] 用户注册/登录
- [x] 考试大厅（考试列表、状态显示）
- [x] 在线答题（倒计时、进度条、键盘导航）
- [x] 4种题型支持：单选、多选、判断、简答
- [x] 自动评分（选择/判断精确匹配，简答模糊匹配）
- [x] 成绩查看与答题回顾
- [x] 历史成绩列表
- [x] 主题切换（Light/Dark）
- [x] Premium UI：Glass Morphism、磁吸效果、流畅动画

### 管理端 (http://localhost:3000/admin)
- [x] 数据概览 Dashboard（用户数/考试数/提交数/通过率）
- [x] 分数分布柱状图
- [x] 最近提交动态
- [x] 考试 CRUD（创建/编辑/删除/发布）
- [x] 题目管理（逐题添加/编辑/删除）
- [x] **批量导入**（JSON格式，一键导入10+题）
- [x] 成绩分析（各题正确率、排名、通过率）
- [x] **CSV导出**成绩
- [x] 用户管理（列表、统计）
- [x] 主题切换

## 启动方式

```bash
cd exam-system
# Windows:
set NODE_PATH=C:\Users\93994\.workbuddy\binaries\node\workspace\node_modules
node server.js

# 或直接运行:
NODE_PATH="C:\\Users\\93994\\.workbuddy\\binaries\\node\\workspace\\node_modules" node server.js
```

## 默认账号

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | admin | admin123 |
| 考生 | 自行注册 | - |

## 题目导入JSON格式

```json
[
  {
    "type": "single_choice",
    "question_text": "题目内容",
    "options": ["选项A", "选项B", "选项C", "选项D"],
    "correct_answer": "A",
    "score": 10
  },
  {
    "type": "multiple_choice",
    "question_text": "多选题目",
    "options": ["选项A", "选项B", "选项C", "选项D"],
    "correct_answer": "A,B,D",
    "score": 15
  },
  {
    "type": "true_false",
    "question_text": "判断题",
    "correct_answer": "TRUE",
    "score": 5
  },
  {
    "type": "short_answer",
    "question_text": "简答题",
    "correct_answer": "参考答案",
    "score": 10
  }
]
```

## API 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/register | 学生注册 |
| POST | /api/auth/login | 登录 |
| GET | /api/exams | 可用考试列表 |
| GET | /api/exams/:id | 考试详情 |
| POST | /api/exams/:id/start | 开始考试 |
| POST | /api/submissions/:id/submit | 提交答卷 |
| GET | /api/submissions/:id/result | 查看成绩 |
| GET | /api/admin/stats | 管理统计 |
| POST | /api/admin/exams | 创建考试 |
| PUT | /api/admin/exams/:id | 编辑考试 |
| DELETE | /api/admin/exams/:id | 删除考试 |
| POST | /api/admin/exams/:id/questions/import | 批量导入 |
| GET | /api/admin/stats/exam/:id | 单考试分析 |
| GET | /api/admin/export/:examId | 导出成绩 |

## 设计亮点

- **Glass Morphism**: backdrop-filter + 半透明边框，高级感
- **主题系统**: Light/Dark 双主题，CSS变量驱动，平滑过渡
- **磁吸交互**: 卡片跟随鼠标微动
- **60fps动画**: cubic-bezier缓动曲线，fadeIn/slideUp动效
- **WAL模式**: SQLite写入优化，支持并发读取
- **响应式布局**: 移动端/平板/桌面全适配
- **倒计时**: 考前3秒倒计时，考试期间实时倒计时，超时自动提交

## 支持规模

- **用户数**: 50+（SQLite WAL模式支持高并发读取）
- **题目数**: 单考试1000+题
- **并发**: 支持多考生同时在线考试
