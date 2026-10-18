# Mobile acceptance / 移动端验收

This synthetic note is for testing inside Obsidian on an actual iPad. Automated WebKit tests are complementary and do not replace this check. Record the app/plugin version, device, theme, and KP switches when reporting a problem.

本笔记仅含合成内容。请记录应用/插件版本、设备、主题和 KP 开关状态；自动化 WebKit 测试不能替代 iPad 实机验收。

## Editing and scrolling / 编辑与滚动

- [ ] In Live Preview, edit both Proof titles below using an English keyboard and a Chinese IME. Only the intended text should change.
- [ ] Select and copy several proof lines. Move the caret outside the proof, hide the keyboard, and scroll in both directions.
- [ ] Rotate between portrait and landscape, then repeat editing and scrolling with KP on and off.
- [ ] Tap a reference and return. Open the diagram editor, select each parallel arrow, change its label, undo, and save.
- [ ] Pause and resume Live Preview enhancements. The source and saved preferences should remain intact.
- [ ] If scrolling stops, start the layout recorder if possible; retain the checkpoint report before restarting Obsidian.

> [!thm] Composition of continuous maps
> If $f:X\to Y$ and $g:Y\to Z$ are continuous, then $g\circ f$ is continuous.

^mobile-composition

> [!proof][[#^mobile-composition]]
>
> Let $U\subseteq Z$ be open. The inverse image $g^{-1}(U)$ is open in $Y$, so $f^{-1}(g^{-1}(U))$ is open in $X$. This gives $(g\circ f)^{-1}(U)=f^{-1}(g^{-1}(U))$. The argument preserves the hypotheses and uses the definition of continuity.
>
> 取一个开集并逐次求原像，就能得到复合映射的连续性。编辑这段文字时，确认中文输入法、光标与选区保持正常；收起键盘以后，应能继续上下滑动。

> [!proof] Editable title / 可编辑标题
> This paragraph tests a named proof. Formulas such as $f^{-1}(U)\subseteq X$ remain indivisible. The paragraph can be copied without inserted visual line breaks. Repeat the edit after rotating the device and changing the width of the note.

## Diagrams / 交换图

```academic-diagram
{
  "version": 1,
  "grid": 2,
  "nodes": [
    {"id": "a", "row": 0, "col": 0, "label": "A"},
    {"id": "b", "row": 0, "col": 1, "label": "B"},
    {"id": "c", "row": 1, "col": 1, "label": "C"}
  ],
  "arrows": [
    {"id": "f", "from": "a", "to": "b", "label": "f", "style": "solid", "side": "above", "head": "injective"},
    {"id": "g", "from": "a", "to": "b", "label": "g", "style": "solid", "side": "below", "head": "surjective"},
    {"id": "h", "from": "b", "to": "c", "label": "\\alpha", "style": "solid", "side": "below", "head": "isomorphism", "curve": 1}
  ],
  "caption": "Parallel arrows and an isomorphism"
}
```

## Return and repeat / 返回重试

Revisit [[#^mobile-composition]]. After editing, scroll back to the top and down again. Check that settings panels, diagram controls, and the note remain usable without restarting the application.

重复上面的检查。出现问题时请注明复现步骤，而不是只提供排版截图；尤其区分阅读视图、实时预览与源码模式。
