import { describe, expect, it } from "vitest";
import {
  annotateNumberedFigures,
  findFigure,
  parseFigures,
  plainFigureCaption,
} from "../../src/context/tex-figures";

describe("parseFigures", () => {
  it("indexes figure environments with captions, labels, and graphics", () => {
    const text = [
      "\\section{Method}",
      "\\begin{figure}[t]",
      "\\includegraphics[width=1.0\\linewidth]{figures/occupancy.pdf}",
      "\\caption{The **occupancy trade-off** between 2D grids \\& 3D points.}",
      "\\label{fig:occupancy}",
      "\\end{figure}",
      "\\begin{figure*}",
      "\\includegraphics{figures/str.png}",
      "\\caption{STR overview.}",
      "\\end{figure*}",
    ].join("\n");

    const figures = parseFigures(text);

    expect(figures).toHaveLength(2);
    expect(figures[0]).toMatchObject({
      number: 1,
      label: "fig:occupancy",
      graphics: ["figures/occupancy.pdf"],
    });
    expect(plainFigureCaption(figures[0])).toBe(
      "The occupancy trade-off between 2D grids & 3D points.",
    );
    expect(findFigure(figures, { number: 2 })?.graphics).toEqual([
      "figures/str.png",
    ]);
    expect(findFigure(figures, { name: "occupancy" })?.number).toBe(1);
  });

  it("adds visible figure-number markers before figure environments", () => {
    const text = [
      "\\begin{figure}",
      "\\includegraphics{figures/a.png}",
      "\\caption{A}",
      "\\end{figure}",
    ].join("\n");

    const out = annotateNumberedFigures(text);

    expect(out).toContain("[Figure (1) graphics=figures/a.png]");
    expect(out.indexOf("[Figure (1)")).toBeLessThan(
      out.indexOf("\\begin{figure}"),
    );
  });

  it("respects explicit LaTeX figure counter resets", () => {
    const text = [
      "\\setcounter{figure}{1}",
      "\\begin{figure}",
      "\\includegraphics{figures/overview.pdf}",
      "\\caption{Overview}",
      "\\label{fig:overview}",
      "\\end{figure}",
      "\\begin{figure}",
      "\\includegraphics{figures/tasks.pdf}",
      "\\caption{Tasks}",
      "\\label{fig:tasks}",
      "\\end{figure}",
    ].join("\n");

    const figures = parseFigures(text);

    expect(figures.map((fig) => fig.number)).toEqual([2, 3]);
    expect(findFigure(figures, { number: 3 })?.label).toBe("fig:tasks");
    expect(annotateNumberedFigures(text)).toContain(
      "[Figure (2) label=fig:overview graphics=figures/overview.pdf]",
    );
  });

  it("applies figure counter changes around captions in document order", () => {
    const text = [
      "\\addtocounter{figure}{2}",
      "\\begin{figure}",
      "\\includegraphics{figures/a.pdf}",
      "\\caption{A}",
      "\\setcounter{figure}{9}",
      "\\end{figure}",
      "\\begin{figure}",
      "\\addtocounter{figure}{-1}",
      "\\includegraphics{figures/b.pdf}",
      "\\caption{B}",
      "\\end{figure}",
      "\\stepcounter{figure}",
      "\\begin{figure}",
      "\\includegraphics{figures/c.pdf}",
      "\\caption{C}",
      "\\end{figure}",
    ].join("\n");

    const figures = parseFigures(text);

    expect(figures.map((fig) => fig.number)).toEqual([3, 9, 11]);
    expect(findFigure(figures, { number: 9 })?.graphics).toEqual([
      "figures/b.pdf",
    ]);
  });
});
