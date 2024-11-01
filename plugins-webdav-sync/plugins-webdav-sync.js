/* 触发器 手动触发 */
const onRun = async () => {
  const action = await Plugins.picker.single(
    '请选择操作',
    [
      { label: '立即备份', value: 'Backup' },
      { label: '同步至本地', value: 'Sync' },
      { label: '查看备份列表', value: 'List' },
      { label: '管理备份列表', value: 'Remove' },
    ],
    []
  )

  const handler = { Backup, Sync, List, Remove }
  await handler[action]()
}

/**
 * 插件钩子：右键 - 同步至本地
 */
const Sync = async () => {
  const dav = new WebDAV(Plugin.Address, Plugin.Username, Plugin.Password)
  const list = await dav.propfind(Plugin.DataPath)
  const _list = filterList(list)
  if (_list.length === 0) throw '没有可同步的备份'

  const fileHref = await Plugins.picker.single('请选择要同步至本地的备份', _list, [_list[0].value])

  const { update, destroy, success, error } = Plugins.message.info('获取备份文件...', 60 * 60 * 1000)

  const content = await dav.get(fileHref)

  const files = JSON.parse(content)

  let failed = false

  const _files = Object.keys(files)
  for (let i = 0; i < _files.length; i++) {
    const file = _files[i]
    const encrypted = files[file].content
    update(`正在恢复文件...[ ${i + 1}/${_files.length} ]`, 'info')
    try {
      await Plugins.Writefile(file, encrypted)
    } catch (error) {
      if (error === '解密失败') {
        failed = true
      }
      console.log(file + ' ： ' + error)
      Plugins.message.error(`恢复文件失败：` + error)
    } finally {
      await Plugins.sleep(100)
    }
  }

  if (failed) {
    error('有文件解密失败，考虑是否是密钥配置错误')
    await Plugins.sleep(3000).then(() => destroy())
    return
  }

  success('同步完成，即将重载界面')
  await Plugins.sleep(1500).then(() => destroy())

  const kernelApiStore = Plugins.useKernelApiStore()
  await kernelApiStore.stopKernel()

  await Plugins.WindowReloadApp()
}

/**
 * 插件钩子：右键 - 立即备份
 */
const Backup = async () => {
  const files = [
    'data/user.yaml',
    'data/profiles.yaml',
    'data/subscribes.yaml',
    'data/rulesets.yaml',
    'data/plugins.yaml',
    'data/scheduledtasks.yaml',
  ]

  const subscribesStore = Plugins.useSubscribesStore()
  const pluginsStore = Plugins.usePluginsStore()
  const rulesetsStore = Plugins.useRulesetsStore()

  const l1 = subscribesStore.subscribes.map((v) => v.path).filter((v) => v.startsWith('data'))
  const l2 = pluginsStore.plugins.map((v) => v.path).filter((v) => v.startsWith('data'))
  const l3 = rulesetsStore.rulesets
    .map((v) => v.path)
    .filter((v) => v.startsWith('data') && (v.endsWith('yaml') || v.endsWith('json')))

  files.push(...l1, ...l2, ...l3)

  const { id } = Plugins.message.info('正在创建备份...', 60 * 60 * 1000)

  const filesMap = {}

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    Plugins.message.update(id, `正在创建备份...[ ${i + 1}/${files.length} ]`)
    try {
      const text = await Plugins.ignoredError(Plugins.Readfile, file)
      if (text) {
        filesMap[file] = { content: text }
      }
    } catch (error) {
      console.log('正在创建备份失败', error)
      Plugins.message.destroy(id)
      throw error
    } finally {
      await Plugins.sleep(100)
    }
  }

  try {
    if (Object.keys(filesMap).length === 0) throw '缺少备份文件'
    Plugins.message.update(id, '正在备份...', 'info')
    const dav = new WebDAV(Plugin.Address, Plugin.Username, Plugin.Password)
    await dav.put(
      Plugin.DataPath + '/' + getPrefix() + '_' + Plugins.formatDate(Date.now(), 'YYYYMMDDHHmmss') + '.json',
      JSON.stringify(filesMap)
    )
    Plugins.message.update(id, '备份完成', 'success')
  } catch (error) {
    console.log('备份失败', error)
    Plugins.message.update(id, `备份失败:` + (error.message || error), 'error')
  }

  await Plugins.sleep(1500).then(() => Plugins.message.destroy(id))
}

const List = async () => {
  const dav = new WebDAV(Plugin.Address, Plugin.Username, Plugin.Password)
  const list = await dav.propfind(Plugin.DataPath)
  const _list = filterList(list)
  if (_list.length === 0) throw '备份列表为空'
  await Plugins.picker.single('备份列表如下：', _list, [])
}

const Remove = async () => {
  const dav = new WebDAV(Plugin.Address, Plugin.Username, Plugin.Password)
  const list = await dav.propfind(Plugin.DataPath)
  const _list = filterList(list)
  if (_list.length === 0) throw '没有可管理的备份'
  const files = await Plugins.picker.multi('请勾选要删除的备份', _list, [])
  for (let i = 0; i < files.length; i++) {
    await dav.delete(files[i])
    Plugins.message.success('删除成功: ' + files[i])
  }
}

const onReady = async () => {}

const getPrefix = () => {
  return Plugins.APP_TITLE.includes('Clash') ? 'GUI.for.Clash' : 'GUI.for.SingBox'
}

const filterList = (list) => {
  const prefix = getPrefix()
  return list
    .filter((v) => v.displayname.startsWith(prefix))
    .map((v) => ({ label: v.displayname, value: v.href }))
    .reverse()
}

class WebDAV {
  constructor(address, username, password) {
    this.address = address
    this.headers = {
      Authorization: 'Basic ' + Plugins.base64Encode(username + ':' + password),
    }
  }

  async propfind(url) {
    const { body, status } = await Plugins.Requests({
      method: 'PROPFIND',
      url: this.address + url,
      headers: { ...this.headers, Depth: '1' },
    })
    if (status !== 207) throw body
    const list = []
    const parser = new DOMParser()
    const xmlDoc = parser.parseFromString(body, 'application/xml')
    const responses = xmlDoc.getElementsByTagName('D:response')
    for (let i = 0; i < responses.length; i++) {
      list.push({
        href: responses[i].getElementsByTagName('D:href')[0].textContent,
        displayname: responses[i].getElementsByTagName('D:displayname')[0]?.textContent || '',
        lastModified: responses[i].getElementsByTagName('D:getlastmodified')[0]?.textContent || 'N/A',
        creationDate: responses[i].getElementsByTagName('D:creationdate')[0]?.textContent || 'N/A',
      })
    }
    return list
  }

  async get(url) {
    const { body, status } = await Plugins.Requests({
      method: 'GET',
      url: this.address + url,
      headers: this.headers,
    })
    if (status !== 200) throw body
    return body
  }

  async put(url, content) {
    console.log(url)

    const { body, status } = await Plugins.Requests({
      method: 'PUT',
      url: this.address + url,
      body: content,
      headers: this.headers,
    })
    if (status !== 201) throw body
    return body
  }

  async delete(url) {
    const { body, status } = await Plugins.Requests({
      method: 'DELETE',
      url: this.address + url,
      headers: this.headers,
    })
    if (status !== 204) throw body
    return body
  }
}
