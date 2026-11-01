// i18n-ignore-file: Server-side validation evidence, not interface copy.
import { z } from 'zod'

export const webUrlSchema = z.string().max(2048).url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && !url.hostname.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
    && url.hostname.includes('.') && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)\.?$/i.test(url.hostname)
}, '只允许读取公开 HTTPS 网页，不支持凭据、IP 地址或自定义端口。')

