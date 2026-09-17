---
name: cnb-upload-attachment
description: 上传附件到 Issue 或 PR 评论
---

# 上传附件到 Issue / PR

将本地文件上传到 CNB 平台的 Issue 或 PR，返回可嵌入评论的 Markdown 附件链接。

## 使用场景

- 在 Issue 或 PR 评论中附加截图、日志文件、构建产物等
- 图片走 `upload-image`，其余文件走 `upload-file`；两者都支持任意扩展名，命令可按需互换

## 执行步骤

### 1. 判断文件类别

先判断文件是否为图片（用于决定评论里是内联展示还是下载链接）：

- **图片** → 使用 `upload-image`，评论以 `![名称](URL)` 内联渲染
- **其他文件** → 使用 `upload-file`，评论以 `[名称](URL)` 下载链接展示

> 后缀清单只作参考，**不是白名单**：未列出的后缀（如 `.bmp`/`.webp` 之外的图片格式）
> 也应按文件真实内容判断。图片类后缀可识别的直接用 `upload-image`，
> 拿不准时用 `upload-file` 兜底即可，不要因后缀不在清单里就报错或拒绝上传。

### 2. 执行上传

上传图片：

```bash
cnb issues upload-image --file 本地文件路径
cnb pulls upload-image --file 本地文件路径
```

上传普通文件：

```bash
cnb issues upload-file --file 本地文件路径
cnb pulls upload-file --file 本地文件路径
```

### 3. 使用上传结果

命令返回 JSON，其中 `asset_link` 字段即附件的 Markdown 链接，可直接嵌入评论使用。