/**
 * 航空公司 ICAO 三字码查表
 * ---------------------------------------------------------------------------
 * ADS-B 的呼号（callsign）前三位就是航空公司的 ICAO 代码，例如
 *   BAW123  → British Airways
 *   RYR23NH → Ryanair
 *   CCA981  → Air China
 *
 * 这张表让列表里的"BAW123"变成"英国航空 BAW123"，是 FR24 这类产品的
 * 基础信息层。只收录高频代码（覆盖全球定期航班约 90%），
 * 完整表有上千条，对首屏加载不值得。
 *
 * 数据来源：ICAO 三字码公开名录（各国民航局公布）+ 人工核对中文名。
 */

export type Airline = {
  /** ICAO 三字码 */
  icao: string;
  /** IATA 二字码（可能为空） */
  iata?: string;
  /** 英文名 */
  name: string;
  /** 中文名 */
  nameZh: string;
  /** 注册国家/地区（中文） */
  country: string;
  /** 国家/地区 ISO 二字码，用于国旗 */
  cc: string;
};

/** 高频航司表。按代码字母序，便于人工核对。 */
export const AIRLINES: Airline[] = [
  // ---- 亚太 ----
  { icao: 'AAR', iata: 'OZ', name: 'Asiana Airlines', nameZh: '韩亚航空', country: '韩国', cc: 'KR' },
  { icao: 'ACA', iata: 'AC', name: 'Air Canada', nameZh: '加拿大航空', country: '加拿大', cc: 'CA' },
  { icao: 'AIC', iata: 'AI', name: 'Air India', nameZh: '印度航空', country: '印度', cc: 'IN' },
  { icao: 'ANA', iata: 'NH', name: 'All Nippon Airways', nameZh: '全日空', country: '日本', cc: 'JP' },
  { icao: 'ANG', iata: 'PX', name: 'Air Niugini', nameZh: '新几内亚航空', country: '巴布亚新几内亚', cc: 'PG' },
  { icao: 'APJ', iata: 'MM', name: 'Peach Aviation', nameZh: '乐桃航空', country: '日本', cc: 'JP' },
  { icao: 'ASA', iata: 'AS', name: 'Alaska Airlines', nameZh: '阿拉斯加航空', country: '美国', cc: 'US' },
  { icao: 'AUA', iata: 'OS', name: 'Austrian Airlines', nameZh: '奥地利航空', country: '奥地利', cc: 'AT' },

  // ---- 中国大陆 ----
  { icao: 'CBJ', iata: 'JD', name: 'Beijing Capital Airlines', nameZh: '首都航空', country: '中国', cc: 'CN' },
  { icao: 'CCA', iata: 'CA', name: 'Air China', nameZh: '中国国际航空', country: '中国', cc: 'CN' },
  { icao: 'CDC', iata: 'GJ', name: 'Loong Air', nameZh: '长龙航空', country: '中国', cc: 'CN' },
  { icao: 'CES', iata: 'MU', name: 'China Eastern Airlines', nameZh: '中国东方航空', country: '中国', cc: 'CN' },
  { icao: 'CHH', iata: 'HU', name: 'Hainan Airlines', nameZh: '海南航空', country: '中国', cc: 'CN' },
  { icao: 'CQH', iata: '9C', name: 'Spring Airlines', nameZh: '春秋航空', country: '中国', cc: 'CN' },
  { icao: 'CSN', iata: 'CZ', name: 'China Southern Airlines', nameZh: '中国南方航空', country: '中国', cc: 'CN' },
  { icao: 'CSZ', iata: 'ZH', name: 'Shenzhen Airlines', nameZh: '深圳航空', country: '中国', cc: 'CN' },
  { icao: 'CXA', iata: 'MF', name: 'Xiamen Airlines', nameZh: '厦门航空', country: '中国', cc: 'CN' },
  { icao: 'CSC', iata: '3U', name: 'Sichuan Airlines', nameZh: '四川航空', country: '中国', cc: 'CN' },
  { icao: 'CYZ', iata: '8L', name: 'Lucky Air', nameZh: '祥鹏航空', country: '中国', cc: 'CN' },
  { icao: 'CXJ', iata: 'GS', name: 'Tianjin Airlines', nameZh: '天津航空', country: '中国', cc: 'CN' },
  { icao: 'DKH', iata: 'HO', name: 'Juneyao Airlines', nameZh: '吉祥航空', country: '中国', cc: 'CN' },

  // ---- 港澳台 ----
  { icao: 'CPA', iata: 'CX', name: 'Cathay Pacific', nameZh: '国泰航空', country: '中国香港', cc: 'HK' },
  { icao: 'HDA', iata: 'UO', name: 'Hong Kong Express', nameZh: '香港快运', country: '中国香港', cc: 'HK' },
  { icao: 'CRK', iata: 'HX', name: 'Hong Kong Airlines', nameZh: '香港航空', country: '中国香港', cc: 'HK' },
  { icao: 'EVA', iata: 'BR', name: 'EVA Air', nameZh: '长荣航空', country: '中国台湾', cc: 'TW' },
  { icao: 'CAL', iata: 'CI', name: 'China Airlines', nameZh: '中华航空', country: '中国台湾', cc: 'TW' },
  { icao: 'AMU', iata: 'NX', name: 'Air Macau', nameZh: '澳门航空', country: '中国澳门', cc: 'MO' },

  // ---- 欧洲 ----
  { icao: 'AFR', iata: 'AF', name: 'Air France', nameZh: '法国航空', country: '法国', cc: 'FR' },
  { icao: 'BAW', iata: 'BA', name: 'British Airways', nameZh: '英国航空', country: '英国', cc: 'GB' },
  { icao: 'DLH', iata: 'LH', name: 'Lufthansa', nameZh: '汉莎航空', country: '德国', cc: 'DE' },
  { icao: 'EZY', iata: 'U2', name: 'easyJet', nameZh: '易捷航空', country: '英国', cc: 'GB' },
  { icao: 'EJU', iata: 'U2', name: 'easyJet Europe', nameZh: '易捷航空（欧洲）', country: '奥地利', cc: 'AT' },
  { icao: 'EWG', iata: 'EW', name: 'Eurowings', nameZh: '欧洲之翼', country: '德国', cc: 'DE' },
  { icao: 'FIN', iata: 'AY', name: 'Finnair', nameZh: '芬兰航空', country: '芬兰', cc: 'FI' },
  { icao: 'IBE', iata: 'IB', name: 'Iberia', nameZh: '西班牙国家航空', country: '西班牙', cc: 'ES' },
  { icao: 'ITY', iata: 'AZ', name: 'ITA Airways', nameZh: '意大利航空', country: '意大利', cc: 'IT' },
  { icao: 'KLM', iata: 'KL', name: 'KLM', nameZh: '荷兰皇家航空', country: '荷兰', cc: 'NL' },
  { icao: 'LOT', iata: 'LO', name: 'LOT Polish Airlines', nameZh: '波兰航空', country: '波兰', cc: 'PL' },
  { icao: 'NAX', iata: 'DY', name: 'Norwegian', nameZh: '挪威航空', country: '挪威', cc: 'NO' },
  { icao: 'RYR', iata: 'FR', name: 'Ryanair', nameZh: '瑞安航空', country: '爱尔兰', cc: 'IE' },
  { icao: 'SAS', iata: 'SK', name: 'SAS', nameZh: '北欧航空', country: '瑞典', cc: 'SE' },
  { icao: 'SWR', iata: 'LX', name: 'Swiss', nameZh: '瑞士国际航空', country: '瑞士', cc: 'CH' },
  { icao: 'TAP', iata: 'TP', name: 'TAP Air Portugal', nameZh: '葡萄牙航空', country: '葡萄牙', cc: 'PT' },
  { icao: 'THY', iata: 'TK', name: 'Turkish Airlines', nameZh: '土耳其航空', country: '土耳其', cc: 'TR' },
  { icao: 'VLG', iata: 'VY', name: 'Vueling', nameZh: '伏林航空', country: '西班牙', cc: 'ES' },
  { icao: 'WZZ', iata: 'W6', name: 'Wizz Air', nameZh: '威兹航空', country: '匈牙利', cc: 'HU' },
  { icao: 'AEE', iata: 'A3', name: 'Aegean Airlines', nameZh: '爱琴海航空', country: '希腊', cc: 'GR' },
  { icao: 'AFL', iata: 'SU', name: 'Aeroflot', nameZh: '俄罗斯航空', country: '俄罗斯', cc: 'RU' },

  // ---- 中东 ----
  { icao: 'ETD', iata: 'EY', name: 'Etihad Airways', nameZh: '阿提哈德航空', country: '阿联酋', cc: 'AE' },
  { icao: 'UAE', iata: 'EK', name: 'Emirates', nameZh: '阿联酋航空', country: '阿联酋', cc: 'AE' },
  { icao: 'QTR', iata: 'QR', name: 'Qatar Airways', nameZh: '卡塔尔航空', country: '卡塔尔', cc: 'QA' },
  { icao: 'SVA', iata: 'SV', name: 'Saudia', nameZh: '沙特航空', country: '沙特阿拉伯', cc: 'SA' },
  { icao: 'ELY', iata: 'LY', name: 'El Al', nameZh: '以色列航空', country: '以色列', cc: 'IL' },

  // ---- 北美 ----
  { icao: 'AAL', iata: 'AA', name: 'American Airlines', nameZh: '美国航空', country: '美国', cc: 'US' },
  { icao: 'DAL', iata: 'DL', name: 'Delta Air Lines', nameZh: '达美航空', country: '美国', cc: 'US' },
  { icao: 'UAL', iata: 'UA', name: 'United Airlines', nameZh: '联合航空', country: '美国', cc: 'US' },
  { icao: 'SWA', iata: 'WN', name: 'Southwest Airlines', nameZh: '西南航空', country: '美国', cc: 'US' },
  { icao: 'JBU', iata: 'B6', name: 'JetBlue', nameZh: '捷蓝航空', country: '美国', cc: 'US' },
  { icao: 'FFT', iata: 'F9', name: 'Frontier Airlines', nameZh: '边疆航空', country: '美国', cc: 'US' },
  { icao: 'NKS', iata: 'NK', name: 'Spirit Airlines', nameZh: '精神航空', country: '美国', cc: 'US' },
  { icao: 'FDX', name: 'FedEx Express', nameZh: '联邦快递', country: '美国', cc: 'US' },
  { icao: 'UPS', name: 'UPS Airlines', nameZh: '联合包裹', country: '美国', cc: 'US' },
  { icao: 'AMX', iata: 'AM', name: 'Aeroméxico', nameZh: '墨西哥航空', country: '墨西哥', cc: 'MX' },

  // ---- 南美 ----
  { icao: 'ARG', iata: 'AR', name: 'Aerolíneas Argentinas', nameZh: '阿根廷航空', country: '阿根廷', cc: 'AR' },
  { icao: 'GLO', iata: 'G3', name: 'Gol Transportes Aéreos', nameZh: '高尔航空', country: '巴西', cc: 'BR' },
  { icao: 'LAN', iata: 'LA', name: 'LATAM Airlines', nameZh: '拉塔姆航空', country: '智利', cc: 'CL' },
  { icao: 'TAM', iata: 'JJ', name: 'LATAM Brasil', nameZh: '拉塔姆航空（巴西）', country: '巴西', cc: 'BR' },
  { icao: 'AVA', iata: 'AV', name: 'Avianca', nameZh: '哥伦比亚航空', country: '哥伦比亚', cc: 'CO' },

  // ---- 大洋洲 ----
  { icao: 'ANZ', iata: 'NZ', name: 'Air New Zealand', nameZh: '新西兰航空', country: '新西兰', cc: 'NZ' },
  { icao: 'JST', iata: 'JQ', name: 'Jetstar', nameZh: '捷星航空', country: '澳大利亚', cc: 'AU' },
  { icao: 'QFA', iata: 'QF', name: 'Qantas', nameZh: '澳洲航空', country: '澳大利亚', cc: 'AU' },
  { icao: 'VOZ', iata: 'VA', name: 'Virgin Australia', nameZh: '维珍澳洲航空', country: '澳大利亚', cc: 'AU' },

  // ---- 东南亚 / 南亚 ----
  { icao: 'AXM', iata: 'AK', name: 'AirAsia', nameZh: '亚洲航空', country: '马来西亚', cc: 'MY' },
  { icao: 'CEB', iata: '5J', name: 'Cebu Pacific', nameZh: '宿务太平洋航空', country: '菲律宾', cc: 'PH' },
  { icao: 'GIA', iata: 'GA', name: 'Garuda Indonesia', nameZh: '印度尼西亚鹰航空', country: '印度尼西亚', cc: 'ID' },
  { icao: 'IGO', iata: '6E', name: 'IndiGo', nameZh: '靛蓝航空', country: '印度', cc: 'IN' },
  { icao: 'MAS', iata: 'MH', name: 'Malaysia Airlines', nameZh: '马来西亚航空', country: '马来西亚', cc: 'MY' },
  { icao: 'PAL', iata: 'PR', name: 'Philippine Airlines', nameZh: '菲律宾航空', country: '菲律宾', cc: 'PH' },
  { icao: 'SIA', iata: 'SQ', name: 'Singapore Airlines', nameZh: '新加坡航空', country: '新加坡', cc: 'SG' },
  { icao: 'TGW', iata: 'TR', name: 'Scoot', nameZh: '酷航', country: '新加坡', cc: 'SG' },
  { icao: 'THA', iata: 'TG', name: 'Thai Airways', nameZh: '泰国国际航空', country: '泰国', cc: 'TH' },
  { icao: 'VJC', iata: 'VJ', name: 'VietJet Air', nameZh: '越捷航空', country: '越南', cc: 'VN' },
  { icao: 'HVN', iata: 'VN', name: 'Vietnam Airlines', nameZh: '越南国家航空', country: '越南', cc: 'VN' },
  { icao: 'AIC', iata: 'AI', name: 'Air India', nameZh: '印度航空', country: '印度', cc: 'IN' },

  // ---- 非洲 ----
  { icao: 'ETH', iata: 'ET', name: 'Ethiopian Airlines', nameZh: '埃塞俄比亚航空', country: '埃塞俄比亚', cc: 'ET' },
  { icao: 'KQA', iata: 'KQ', name: 'Kenya Airways', nameZh: '肯尼亚航空', country: '肯尼亚', cc: 'KE' },
  { icao: 'MSR', iata: 'MS', name: 'EgyptAir', nameZh: '埃及航空', country: '埃及', cc: 'EG' },
  { icao: 'RAM', iata: 'AT', name: 'Royal Air Maroc', nameZh: '摩洛哥皇家航空', country: '摩洛哥', cc: 'MA' },
  { icao: 'SAA', iata: 'SA', name: 'South African Airways', nameZh: '南非航空', country: '南非', cc: 'ZA' },
];

/** 派生的查表：ICAO 三字码 → 航司。重复代码以先出现的为准。 */
const BY_ICAO: Map<string, Airline> = (() => {
  const m = new Map<string, Airline>();
  for (const a of AIRLINES) if (!m.has(a.icao)) m.set(a.icao, a);
  return m;
})();

/**
 * 从呼号里拆出航空公司与航班号。
 *
 * ADS-B 呼号格式是「三字码 + 航班号」，末尾常有空格填充：
 *   "BAW123  " → { airline: British Airways, flightNo: "123" }
 *   "RYR23NH"  → { airline: Ryanair, flightNo: "23NH" }
 *
 * 军用/公务机常是纯注册号（如 "N12345"、"B-2022"），此时返回 null。
 */
export function parseCallsign(callsign: string): {
  airline: Airline | null;
  flightNo: string;
  prefix: string;
} {
  const cs = (callsign || '').trim().toUpperCase();
  if (cs.length < 4) return { airline: null, flightNo: '', prefix: '' };

  const prefix = cs.slice(0, 3);
  const rest = cs.slice(3).trim();
  const airline = BY_ICAO.get(prefix) ?? null;

  // 只有三字码全字母才可能是 ICAO 航司码；
  // 注册号（N12345 / B2022 / D-ABCD）不符合这个形态
  if (!airline || !/^[A-Z]{3}$/.test(prefix) || !/^[A-Z0-9]{1,5}$/.test(rest)) {
    return { airline: null, flightNo: '', prefix };
  }
  return { airline, flightNo: rest, prefix };
}

/** 航司的中文显示名（找不到就退回 ICAO 码） */
export function airlineLabel(icao: string): string {
  return BY_ICAO.get(icao)?.nameZh ?? icao;
}

/** 国家区号 → emoji 国旗。非两位字母或未知区号返回空串。 */
export function flagEmoji(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return '';
  const base = 0x1f1e6;
  const A = 'A'.charCodeAt(0);
  return String.fromCodePoint(
    base + (cc.toUpperCase().charCodeAt(0) - A),
    base + (cc.toUpperCase().charCodeAt(1) - A),
  );
}
