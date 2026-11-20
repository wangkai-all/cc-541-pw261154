'use strict';

/**
 * A deliberately grubby local sample: a torn overview, printed page numbers
 * that restart per chapter, and an errata leaf without its own printed number.
 *
 * - `sheet`     = physical position inside the captured archive item (scan order)
 * - `pageLabel` = what a human sees printed on the leaf (print order)
 * - `text`      = the page body; `signature` is the checksum of the stored original
 *
 * The journal item contains one leaf that was scanned twice with an identical
 * checksum, and two different chapters that both print "1" and "2".
 */
const SAMPLE_ARCHIVE = {
  label: 'NL-LOCAL / 馆藏样例 · 两套分页',
  note: '本地样例，无外部服务。扫描页序按采集器入库顺序，印刷页码按纸页上的数字；第二章从第 1 页重新起排。',
  items: [
    {
      id: 'ITEM-ATLAS',
      title: '图册：港区水路测绘图',
      edition: '1987 初版',
      note: '装订时第 2、3 页顺序颠倒，扫描仪按纸页物理顺序采集，印刷页码按页上数字排序；另夹入一张无页码的 1991 年勘误条。',
      scan: [
        {
          id: 'scan-atlas-001',
          sheet: 1,
          pageLabel: '1',
          kind: 'page',
          signature: 'atlas:0001',
          text: '总图 港区水路。比例尺 一比五千。东岸闸口以双线表示，西岸为货物堆场。',
        },
        {
          // Physically bound before page 2, but printed as page 3.
          id: 'scan-atlas-003',
          sheet: 2,
          pageLabel: '3',
          kind: 'page',
          signature: 'atlas:0003',
          text: '分图 B 南岸堆场。四号与五号仓库之间留出消防通道，宽六米。',
        },
        {
          id: 'scan-atlas-err-1',
          sheet: 3,
          pageLabel: '勘误 (无页码)',
          kind: 'errata',
          section: '',
          signature: 'atlas:errata-1991-1',
          anchor: { section: '', pageLabel: '2' },
          text: '1991 年勘误：第二页图例中的“双线”应读作“虚线”，其余不变。',
          note: '原版夹入的勘误纸条，编号 ERR-1；按内容锚定在第 2 页之后。',
        },
        {
          id: 'scan-atlas-002',
          sheet: 4,
          pageLabel: '2',
          kind: 'page',
          signature: 'atlas:0002',
          text: '分图 A 北岸码头。潮位基准线以南三米设系缆桩，夜间以红灯标识。',
        },
        {
          id: 'scan-atlas-004',
          sheet: 5,
          pageLabel: '4',
          kind: 'page',
          signature: 'atlas:0004',
          text: '分图 C 西岸渡口。候船廊以点划线围出，涨潮时关闭。',
        },
      ],
    },
    {
      id: 'ITEM-JOURNAL',
      title: '年鉴：河港记事（卷一）',
      edition: '1954 合订',
      note: '第一章与第二章各自从第 1 页起排；第四张底片被重复扫描一次。',
      scan: [
        {
          id: 'scan-journal-001',
          sheet: 1,
          pageLabel: '1',
          kind: 'page',
          section: '第一章',
          signature: 'journal:c1:p1',
          text: '第一章 河口。河床以青灰色细砂为主，春季水位上涨约两米。',
        },
        {
          id: 'scan-journal-002',
          sheet: 2,
          pageLabel: '2',
          kind: 'page',
          section: '第一章',
          signature: 'journal:c1:p2',
          text: '渡口每日开放两次，遇雾则停航。',
        },
        {
          id: 'scan-journal-003',
          sheet: 3,
          pageLabel: '1',
          kind: 'page',
          section: '第二章',
          signature: 'journal:c2:p1',
          text: '第二章 渡口。开篇重复第一章的版式，并非重印。',
        },
        {
          id: 'scan-journal-004',
          sheet: 4,
          pageLabel: '2',
          kind: 'page',
          section: '第二章',
          signature: 'journal:c2:p2',
          text: '第二章的过渡页，与第一章第二页呼应，但版面不同。',
        },
        {
          id: 'scan-journal-005-dup',
          sheet: 5,
          pageLabel: '2',
          kind: 'page',
          section: '第二章',
          signature: 'journal:c2:p2',
          text: '第二章的过渡页，与第一章第二页呼应，但版面不同。',
          note: '同一张底片被扫描了两次（与 scan-journal-004 校验和相同）。',
        },
      ],
    },
  ],
};

/**
 * A second independent local fixture used by tests to exercise conflicting
 * checksums on one page number and an unmapped page leaf.
 */
const SAMPLE_TEST_ARCHIVE = {
  label: 'TEST / 覆盖异常',
  note: '测试夹具',
  items: [
    {
      id: 'ITEM-T',
      title: '测试册',
      edition: '测试',
      scan: [
        { id: 't-001', sheet: 1, pageLabel: '1', kind: 'page', signature: 't:1', text: '第一页正文。' },
        { id: 't-002', sheet: 2, pageLabel: '2', kind: 'page', signature: 't:2', text: '第二页正文。' },
        {
          id: 't-002-repeat',
          sheet: 3,
          pageLabel: '2',
          kind: 'page',
          signature: 't:2',
          text: '第二页正文。',
          note: '同一底片的第二张扫描。',
        },
        { id: 't-003', sheet: 4, pageLabel: '3', kind: 'page', signature: 't:3', text: '第三页正文。' },
        {
          id: 't-003-near',
          sheet: 5,
          pageLabel: '3',
          kind: 'page',
          signature: 't:3-near',
          text: '第三页正文（墨色不同，疑为不同印次）。',
          note: '页码相同但校验和不同。',
        },
        {
          id: 't-err',
          sheet: 6,
          pageLabel: '说明 (无页码)',
          kind: 'errata',
          section: '',
          anchor: { section: '', pageLabel: '3' },
          signature: 't:err',
          text: '说明：第四页缺页，以本说明代替。',
        },
      ],
    },
  ],
};

module.exports = {
  SAMPLE_ARCHIVE: JSON.parse(JSON.stringify(SAMPLE_ARCHIVE)),
  SAMPLE_TEST_ARCHIVE: JSON.parse(JSON.stringify(SAMPLE_TEST_ARCHIVE)),
};
