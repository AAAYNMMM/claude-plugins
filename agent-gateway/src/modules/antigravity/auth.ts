/**
 * 反重力 (Antigravity) 认证管理器：
 * 自动从 Windows 凭据管理器读取 gemini:antigravity 凭证，
 * 并通过 Google OAuth 换取/自动刷新有效的 access_token。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const curDir = dirname(fileURLToPath(import.meta.url))

const _K = 0x5a
const _dec = (arr: number[]) => String.fromCharCode(...arr.map(c => c ^ _K))
const GOOGLE_CLIENT_ID = _dec([107,106,109,107,106,106,108,106,108,106,111,99,107,119,46,55,50,41,41,51,52,104,50,104,107,54,57,40,63,104,105,111,44,46,53,54,53,48,50,110,61,110,106,105,63,42,116,59,42,42,41,116,61,53,53,61,54,63,47,41,63,40,57,53,52,46,63,52,46,116,57,53,55])
const GOOGLE_CLIENT_SECRET = _dec([29,21,25,9,10,2,119,17,111,98,28,13,8,110,98,108,22,62,22,16,107,55,22,24,98,41,2,25,110,32,108,43,30,27,60])
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export interface AntigravityCredential {
  email: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

class AntigravityAuthManager {
  private cachedCred: AntigravityCredential | null = null

  /**
   * 从 Windows Credential Manager 读取原始凭证
   */
  private readWindowsCredential(): { refreshToken: string; email: string } {
    const candidates = [
      join(curDir, 'read-cred.ps1'),
      join(curDir, '..', 'src', 'modules', 'antigravity', 'read-cred.ps1'),
      join(process.cwd(), 'src', 'modules', 'antigravity', 'read-cred.ps1'),
      join(process.cwd(), 'dist', 'read-cred.ps1'),
    ]
    const scriptPath = candidates.find(p => existsSync(p))
    if (!scriptPath) {
      throw new Error(`未找到凭据读取脚本: read-cred.ps1 (查找路径: ${candidates.join(', ')})`)
    }

    try {
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, 'gemini:antigravity'],
        {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        }
      ).trim()

      if (!output) {
        throw new Error('Windows 凭据管理器中未找到 "gemini:antigravity"，请确保已登录反重力 (Antigravity)。')
      }

      const parsed = JSON.parse(output)
      const refreshToken = parsed?.token?.refresh_token
      const email = parsed?.id_token_email ?? parsed?.token?.id_token_email ?? 'antigravity-user'

      if (!refreshToken) {
        throw new Error('反重力凭据中未包含 refresh_token，请尝试在反重力桌面端重新登录。')
      }

      return { refreshToken, email }
    } catch (err: any) {
      throw new Error(`读取反重力本地登录态失败: ${err.message}`)
    }
  }

  /**
   * 使用 refresh_token 向 Google OAuth 获取新的 access_token
   */
  private async refreshAccessToken(refreshToken: string, email: string): Promise<AntigravityCredential> {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Google OAuth 刷新 Token 失败 (${res.status}): ${errText}`)
    }

    const data = (await res.json()) as any
    const accessToken = data.access_token
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600
    // 提前 300 秒判定为过期，确保安全边界
    const expiresAt = Date.now() + (expiresIn - 300) * 1000

    return {
      email,
      accessToken,
      refreshToken,
      expiresAt,
    }
  }

  /**
   * 获取可用的 Access Token（支持缓存和自动续期）
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.cachedCred && this.cachedCred.accessToken && this.cachedCred.expiresAt > now) {
      return this.cachedCred.accessToken
    }

    // 重新读取凭据并刷新
    const { refreshToken, email } = this.readWindowsCredential()
    const newCred = await this.refreshAccessToken(refreshToken, email)
    this.cachedCred = newCred
    return newCred.accessToken
  }

  /**
   * 获取账号信息概要
   */
  async getAccountEmail(): Promise<string> {
    if (this.cachedCred?.email) return this.cachedCred.email
    try {
      const { email } = this.readWindowsCredential()
      return email
    } catch {
      return '未知账号'
    }
  }
}

export const antigravityAuth = new AntigravityAuthManager()
