/**
 * 机场与城市的中文名
 * ---------------------------------------------------------------------------
 * OpenFlights 的机场数据只有英文（Tokyo / Narita / Japan），
 * 但中文用户搜索时输入的是"东京""浦东""希思罗"。
 * 没有这层映射，全局搜索对中文用户等于不可用。
 *
 * 覆盖策略：
 *   · 城市名：全球主要城市 + 全部中国通航点
 *   · 机场名：中国全部枢纽 + 全球知名机场
 * 未收录的退回英文原名（搜索仍可用英文）。
 */

/** IATA → 中文城市名 */
export const CITY_ZH: Record<string, string> = {
  // ---- 中国 ----
  PEK: '北京', PKX: '北京', NAY: '北京',
  PVG: '上海', SHA: '上海',
  CAN: '广州', SZX: '深圳', CTU: '成都', TFU: '成都',
  CKG: '重庆', XIY: '西安', KMG: '昆明', HGH: '杭州',
  NKG: '南京', WUH: '武汉', CSX: '长沙', XMN: '厦门',
  TAO: '青岛', TSN: '天津', CGO: '郑州', SYX: '三亚',
  HAK: '海口', URC: '乌鲁木齐', HRB: '哈尔滨', SHE: '沈阳',
  DLC: '大连', FOC: '福州', NNG: '南宁', KWE: '贵阳',
  LHW: '兰州', TNA: '济南', HFE: '合肥', TYN: '太原',
  LXA: '拉萨', XNN: '西宁', INC: '银川', YNT: '烟台',
  WUX: '无锡', NGB: '宁波', WNZ: '温州', JJN: '泉州',
  ZUH: '珠海', SWA: '揭阳', HET: '呼和浩特',

  // ---- 港澳台 ----
  HKG: '香港', MFM: '澳门', TPE: '台北', TSA: '台北',
  KHH: '高雄', RMQ: '台中',

  // ---- 日韩 ----
  NRT: '东京', HND: '东京', KIX: '大阪', ITM: '大阪',
  NGO: '名古屋', FUK: '福冈', CTS: '札幌', OKA: '冲绳',
  ICN: '首尔', GMP: '首尔', PUS: '釜山',

  // ---- 东南亚 ----
  SIN: '新加坡', BKK: '曼谷', DMK: '曼谷', KUL: '吉隆坡',
  CGK: '雅加达', DPS: '巴厘岛', MNL: '马尼拉', CEB: '宿务',
  HAN: '河内', SGN: '胡志明市', RGN: '仰光', PNH: '金边',
  VTE: '万象', KTI: '金边',

  // ---- 南亚 / 中亚 ----
  DEL: '德里', BOM: '孟买', BLR: '班加罗尔', MAA: '金奈',
  CCU: '加尔各答', HYD: '海得拉巴', KTM: '加德满都',
  DAC: '达卡', CMB: '科伦坡', ISB: '伊斯兰堡', KHI: '卡拉奇',
  TAS: '塔什干', ALA: '阿拉木图',

  // ---- 中东 ----
  DXB: '迪拜', AUH: '阿布扎比', SHJ: '沙迦', DOH: '多哈',
  RUH: '利雅得', JED: '吉达', KWI: '科威特', BAH: '巴林',
  MCT: '马斯喀特', IKA: '德黑兰', TLV: '特拉维夫', AMM: '安曼',

  // ---- 欧洲 ----
  LHR: '伦敦', LGW: '伦敦', STN: '伦敦', LTN: '伦敦',
  LCY: '伦敦', MAN: '曼彻斯特', EDI: '爱丁堡', BHX: '伯明翰',
  DUB: '都柏林', CDG: '巴黎', ORY: '巴黎', NCE: '尼斯',
  LYS: '里昂', MRS: '马赛', FRA: '法兰克福', MUC: '慕尼黑',
  BER: '柏林', DUS: '杜塞尔多夫', HAM: '汉堡', STR: '斯图加特',
  AMS: '阿姆斯特丹', BRU: '布鲁塞尔', ZRH: '苏黎世', GVA: '日内瓦',
  VIE: '维也纳', MAD: '马德里', BCN: '巴塞罗那', LIS: '里斯本',
  OPO: '波尔图', FCO: '罗马', MXP: '米兰', LIN: '米兰',
  VCE: '威尼斯', NAP: '那不勒斯', ATH: '雅典', IST: '伊斯坦布尔',
  SAW: '伊斯坦布尔', CPH: '哥本哈根', ARN: '斯德哥尔摩', OSL: '奥斯陆',
  HEL: '赫尔辛基', KEF: '雷克雅未克', WAW: '华沙', PRG: '布拉格',
  BUD: '布达佩斯', OTP: '布加勒斯特', SOF: '索菲亚', BEG: '贝尔格莱德',
  ZAG: '萨格勒布', LED: '圣彼得堡', SVO: '莫斯科', DME: '莫斯科',
  KBP: '基辅', MSQ: '明斯克', RIX: '里加', TLL: '塔林',
  LUX: '卢森堡', MUC2: '慕尼黑',

  // ---- 北美 ----
  JFK: '纽约', LGA: '纽约', EWR: '纽约',
  LAX: '洛杉矶', SFO: '旧金山', SJC: '圣何塞', OAK: '奥克兰',
  SEA: '西雅图', PDX: '波特兰', SAN: '圣地亚哥',
  ORD: '芝加哥', MDW: '芝加哥', ATL: '亚特兰大', MIA: '迈阿密',
  FLL: '劳德代尔堡', MCO: '奥兰多', TPA: '坦帕',
  IAD: '华盛顿', DCA: '华盛顿', BWI: '巴尔的摩',
  BOS: '波士顿', PHL: '费城', DTW: '底特律', MSP: '明尼阿波利斯',
  DEN: '丹佛', PHX: '凤凰城', LAS: '拉斯维加斯', SLC: '盐湖城',
  IAH: '休斯顿', DFW: '达拉斯', AUS: '奥斯汀', SAT: '圣安东尼奥',
  HNL: '檀香山', ANC: '安克雷奇',
  YYZ: '多伦多', YVR: '温哥华', YUL: '蒙特利尔', YYC: '卡尔加里',
  YOW: '渥太华', YEG: '埃德蒙顿',
  MEX: '墨西哥城', CUN: '坎昆', GDL: '瓜达拉哈拉',

  // ---- 南美 ----
  GRU: '圣保罗', GIG: '里约热内卢', BSB: '巴西利亚',
  EZE: '布宜诺斯艾利斯', SCL: '圣地亚哥', LIM: '利马',
  BOG: '波哥大', UIO: '基多', CCS: '加拉加斯', MVD: '蒙得维的亚',
  ASU: '亚松森', VVI: '圣克鲁斯',

  // ---- 大洋洲 ----
  SYD: '悉尼', MEL: '墨尔本', BNE: '布里斯班', PER: '珀斯',
  ADL: '阿德莱德', CNS: '凯恩斯', OOL: '黄金海岸',
  AKL: '奥克兰', CHC: '基督城', WLG: '惠灵顿',
  NAN: '楠迪', PPT: '帕皮提', GUM: '关岛',

  // ---- 非洲 ----
  CAI: '开罗', JNB: '约翰内斯堡', CPT: '开普敦', DUR: '德班',
  NBO: '内罗毕', ADD: '亚的斯亚贝巴', LOS: '拉各斯', ABV: '阿布贾',
  ACC: '阿克拉', DAR: '达累斯萨拉姆', KGL: '基加利',
  CMN: '卡萨布兰卡', ALG: '阿尔及尔', TUN: '突尼斯',
  TIP: '的黎波里', KRT: '喀土穆', MRU: '毛里求斯',
};

/** IATA → 中文机场名（只收录名字与城市不同的知名机场） */
export const AIRPORT_ZH: Record<string, string> = {
  PEK: '首都国际机场', PKX: '大兴国际机场',
  PVG: '浦东国际机场', SHA: '虹桥国际机场',
  CAN: '白云国际机场', SZX: '宝安国际机场',
  CTU: '双流国际机场', TFU: '天府国际机场',
  HKG: '香港国际机场', MFM: '澳门国际机场',
  TPE: '桃园国际机场', TSA: '松山机场',
  LHR: '希思罗机场', LGW: '盖特威克机场', STN: '斯坦斯特德机场',
  CDG: '戴高乐机场', ORY: '奥利机场',
  FRA: '法兰克福机场', MUC: '慕尼黑机场',
  AMS: '史基浦机场', ZRH: '苏黎世机场',
  JFK: '肯尼迪国际机场', EWR: '纽瓦克自由机场', LGA: '拉瓜迪亚机场',
  LAX: '洛杉矶国际机场', SFO: '旧金山国际机场',
  ORD: '奥黑尔国际机场', ATL: '哈茨菲尔德-杰克逊机场',
  DXB: '迪拜国际机场', DOH: '哈马德国际机场',
  SIN: '樟宜机场', NRT: '成田国际机场', HND: '羽田机场',
  ICN: '仁川国际机场', BKK: '素万那普机场',
  SYD: '金斯福德·史密斯机场', MEL: '图拉马林机场',
  JNB: '奥利弗·坦博国际机场', CAI: '开罗国际机场',
  GRU: '瓜鲁柳斯国际机场', MEX: '贝尼托·华雷斯国际机场',
};

/** 取中文城市名，找不到退回英文 */
export function cityZh(iata: string, fallback: string): string {
  return CITY_ZH[iata] || fallback;
}

/** 取中文机场名，找不到退回英文 */
export function airportZh(iata: string, fallback: string): string {
  return AIRPORT_ZH[iata] || fallback;
}

/**
 * 反向索引：中文城市名 → IATA 列表。
 * 一个中文城市可能对应多个机场（上海 → PVG + SHA），
 * 搜索结果里都要出现。
 */
export const CITY_ZH_INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [iata, zh] of Object.entries(CITY_ZH)) {
    const cur = m.get(zh);
    if (cur) cur.push(iata);
    else m.set(zh, [iata]);
  }
  return m;
})();
