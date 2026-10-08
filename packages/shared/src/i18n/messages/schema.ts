/**
 * 字典类型工具：让「英文覆盖度」由编译器守门。
 *
 * 中文是源语言，`zh-CN/*` 的对象字面量类型是**唯一真值形状**。其它语言标注成
 * `LocalizedOf<typeof 中文>`，于是少键、拼错键、值类型写错都会在 tsc 阶段报错。
 *
 * 唯一的例外是复数形态：中文单复数同形，字典里只写裸键（`songs`），
 * 英文需要补一条 `songs_one`。若类型严格等于中文形状，这条 `songs_one`
 * 会被 excess property check 判为「多余属性」而报错——于是这里显式放行
 * **任意 `_<pluralCategory>` 后缀的额外键**。
 *
 * 放行的代价（被有意接受）：英文可以在任意层级多写一个 `xxx_one` 而不被编译器
 * 追问。兜底由两处承担——一致性测试会校验「多余键必须带复数后缀且基键存在」，
 * 门禁脚本会扫描字典里的空值。
 */
export type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

/** 与中文形状同构的译文树，外加放行的复数后缀键 */
export type LocalizedOf<T> = {
  [K in keyof T]: T[K] extends string ? string : LocalizedOf<T[K]>
} & {
  [K in `${string}_${PluralSuffix}`]: string
}
