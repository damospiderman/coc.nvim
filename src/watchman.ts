import {Client} from 'fb-watchman'
import watchman = require('fb-watchman')
import fs from 'fs'
import path from 'path'
import which from 'which'
import uuidv1 = require('uuid/v1')
import os from 'os'
const logger = require('./util/logger')('watchman')
const requiredCapabilities = ['relative_root', 'cmd-watch-project', 'wildmatch']

export interface WatchResponse {
  warning?: string
  watcher: string
  watch: string
}

export interface FileChangeItem {
  size: number
  name: string
  exists: boolean
  type: string
  mtime_ms: number
  ['content.sha1hex']: string
}

export interface FileChange {
  root: string
  subscription: string
  files: FileChangeItem[]
}

export type ChangeCallback = (FileChange) => void

/**
 * Watchman wrapper for fb-watchman client
 *
 * @public
 */
export default class Watchman {
  private static watched:Set<string> = new Set()
  private client: Client
  private relative_path: string | null
  private clock: string | null

  constructor(binaryPath: string) {
    this.client = new watchman.Client({
      watchmanBinaryPath: binaryPath
    })
  }

  private checkCapability(): Promise<boolean> {
    let {client} = this
    return new Promise((resolve, reject) => {
      client.capabilityCheck({
        optional: [],
        required: requiredCapabilities
      }, (error, resp) => {
        if (error) return reject(error)
        let {capabilities} = resp
        for (let key of Object.keys(capabilities)) {
          if (!capabilities[key]) return resolve(false)
        }
        resolve(true)
      })
    })
  }

  private async watchProject(root: string): Promise<boolean> {
    let o = path.parse(root)
    if (root === os.homedir() || o.root === o.dir) {
      return false
    }
    let resp = await this.command(['watch-project', root])
    let {watch, warning} = (resp as WatchResponse)
    if (warning) logger.warn(warning)
    this.relative_path = watch
    resp = await this.command(['clock', watch])
    this.clock = resp.clock
    logger.info(`watchman watching project ${root}`)
    return true
  }

  private command(args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      this.client.command(args, (error, resp) => {
        if (error) return reject(error)
        resolve(resp)
      })
    })
  }

  public async subscribe(globPattern: string, cb: ChangeCallback): Promise<string> {
    let {clock, relative_path} = this
    if (!clock) return null
    let uid = uuidv1()
    let sub = {
      expression: ['allof', ['match', globPattern, 'wholename']],
      fields: ['name', 'size', 'exists', 'type', 'mtime_ms', 'ctime_ms', 'content.sha1hex'],
      since: clock,
    }
    let {subscribe} = await this.command(['subscribe', relative_path, uid, sub])
    this.client.on('subscription', resp => {
      if (resp.subscription != uid || !resp) return
      let {files} = resp
      files.map(f => f.mtime_ms = +f.mtime_ms)
      cb(resp)
    })
    return subscribe
  }

  public unsubscribe(subscription): void {
    this.command(['unsubscribe', this.relative_path, subscription]).catch(error => {
      logger.error(error.message)
    })
  }

  public static async createClient(binaryPath: string, root: string): Promise<Watchman | null> {
    if (root == os.homedir()) return null
    let client = new Watchman(binaryPath)
    let watching:boolean = Watchman.watched.has(root)
    if (watching) return client
    try {
      Watchman.watched.add(root)
      let checked = await client.checkCapability()
      if (!checked) return null
      watching = await client.watchProject(root)
    } catch (e) {
      logger.error(e.message)
      return null
    }
    return watching ? client : null
  }

  public static getBinaryPath(path: string): string | null {
    if (path && fs.existsSync(path)) return path
    try {
      path = which.sync('watchman')
      return path
    } catch (e) {
      return null
    }
  }
}
