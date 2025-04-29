import potrace from 'potrace';
import fs from 'fs-extra';
import sharp, { Metadata } from 'sharp';
import quantize from 'quantize';
import SVGO from 'svgo';
import NearestColor from 'nearest-color';
import replaceAll from 'string.prototype.replaceall';
import getColors from 'get-image-colors';

replaceAll.shim();

const hexToRgb = (hex: string): number[] =>
  hex
    .replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, (_m, r, g, b) => '#' + r + r + g + g + b + b)
    .substring(1)
    .match(/.{2}/g)!
    .map((x) => parseInt(x, 16));

function hexify(color: string): string {
  const values = color.replace(/rgba?\(/, '').replace(/\)/, '').replace(/\s+/g, '').split(',');
  const a = parseFloat(values[3] || '1');
  const r = Math.floor(a * parseInt(values[0]) + (1 - a) * 255);
  const g = Math.floor(a * parseInt(values[1]) + (1 - a) * 255);
  const b = Math.floor(a * parseInt(values[2]) + (1 - a) * 255);
  return `#${[r, g, b].map((n) => ('0' + n.toString(16)).slice(-2)).join('')}`;
}

function combineOpacity(a: number, b: number): number {
  return 1 - (1 - a) * (1 - b);
}

function getSolid(svg: string, stroke: boolean): string {
  svg = svg.replaceAll('fill="black"', '');
  const opacityRegex = /fill-opacity="[\d.]+"/gi;
  const numberRegex = /[\d.]+/;
  const matches = svg.match(opacityRegex) || [];
  const colors = Array.from(new Set(matches))
    .map((fillOpacity) => ({
      fillOpacity,
      opacity: Number(fillOpacity.match(numberRegex)![0]),
    }))
    .sort((a, b) => b.opacity - a.opacity)
    .map(({ fillOpacity, opacity }, index, array) => {
      const lighterColors = array.slice(index);
      const trueOpacity = lighterColors.reduce((acc, cur) => combineOpacity(acc, cur.opacity), 0);
      const hex = hexify(`rgba(0,0,0,${trueOpacity})`);
      return { trueOpacity, fillOpacity, opacity, hex };
    });

  for (const color of colors) {
    if (stroke) {
      svg = svg.replaceAll(color.fillOpacity, `fill="${color.hex}" stroke-width="1" stroke="${color.hex}"`);
      svg = svg.replaceAll(' stroke="none"', '');
    } else {
      svg = svg.replaceAll(color.fillOpacity, `fill="${color.hex}"`);
      svg = svg.replaceAll(' stroke="none"', '');
    }
  }
  return svg;
}

async function getPixels(input: Buffer | string): Promise<{ pixels: number[][]; channels: number }> {
  const image = sharp(input);
  const metadata: Metadata = await image.metadata();
  const raw = await image.raw().toBuffer();

  const pixels: number[][] = [];
  const channels = metadata.channels ?? 4;
  for (let i = 0; i < raw.length; i += channels) {
    const pixel: number[] = [];
    for (let j = 0; j < channels; j++) {
      pixel.push(raw.readUInt8(i + j));
    }
    pixels.push(pixel);
  }
  return { pixels, channels };
}

async function replaceColors(svg: string, original: Buffer): Promise<string> {
  const metadata: Metadata = await sharp(original).metadata();
  if ((metadata.channels ?? 0) === 1) return svg;

  const hexRegex = /#([a-f0-9]{3}){1,2}\b/gi;
  const matches = svg.match(hexRegex) || [];
  const colors = Array.from(new Set(matches));
  const pixelIndexesOfNearestColors: Record<string, number[]> = {};
  colors.forEach((c) => (pixelIndexesOfNearestColors[c] = []));

  const svgPixels = await getPixels(Buffer.from(svg));
  const nearestColor = NearestColor.from(colors);

  svgPixels.pixels.forEach((pixel: number[], index: number) => {
    const hex = hexify(`rgba(${pixel.join(',')},${svgPixels.channels === 4 ? pixel[3] / 255 : 1})`);
    pixelIndexesOfNearestColors[nearestColor(hex)].push(index);
  });

  const originalPixels = await getPixels(original);
  const colorHexMap: Record<string, string[]> = {};

  for (const hexKey in pixelIndexesOfNearestColors) {
    colorHexMap[hexKey] = pixelIndexesOfNearestColors[hexKey].map((i) => {
      const p = originalPixels.pixels[i];
      return hexify(`rgba(${p.join(',')},${originalPixels.channels === 4 ? p[3] / 255 : 1})`);
    });
  }

  const colorsToReplace: Record<string, string> = {};
  for (const [hexKey, hexList] of Object.entries(colorHexMap)) {
    const pixelArray = hexList.map(hexToRgb);
    const colorMap = quantize(pixelArray, 5);
    const [r, g, b] = colorMap.palette()[0];
    colorsToReplace[hexKey] = hexify(`rgb(${r},${g},${b})`);
  }

  for (const [oldColor, newColor] of Object.entries(colorsToReplace)) {
    svg = svg.replaceAll(oldColor, newColor);
  }

  return svg;
}

function viewBoxify(svg: string): string {
  const width = svg.split('width="')[1].split('"')[0];
  const height = svg.split('height="')[1].split('"')[0];
  const originalHeader = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  return svg.replace(originalHeader, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`);
}

export async function parseImage(imageName: string, step: number, colors: string[]): Promise<void> {
  const svg = await new Promise<string>((resolve, reject) => {
    potrace.posterize(`./${imageName}.png`, { optTolerance: 0.5, steps: step }, (err: Error | null, svg: string) => {
      if (err) return reject(err);
      resolve(svg);
    });
  });

  let modifiedSvg = getSolid(svg, step !== 1);

  if (step === 1) {
    const paths = modifiedSvg.split('<path');
    modifiedSvg = paths[0] + '<path' + paths[2];
    const color = modifiedSvg.split('#')[1].split('"')[0];
    modifiedSvg = modifiedSvg.replaceAll(`#${color}`, colors[0]);
  } else {
    const buffer = await fs.readFile(`./${imageName}.png`);
    modifiedSvg = await replaceColors(modifiedSvg, buffer);
  }

  const optimized = await SVGO.optimize(modifiedSvg);
  const finalSvg = viewBoxify(optimized.data);
  await fs.outputFile(`./${imageName}.svg`, finalSvg);
}

export async function inspectImage(imageName: string): Promise<{ step: number; colors: string[] }[]> {
  const listColors = (await getColors(`./${imageName}.png`, { count: 5 })) as { hsl: () => number[]; rgb: () => number[]; hex: () => string }[];
  let hslList = listColors.map((color) => color.hsl());
  const hexList = listColors.map((color) => color.hex());

  const options: { step: number; colors: string[] }[] = [];
  const isWhiteBackground = hslList[0][2] > 0.8;
  if (isWhiteBackground) {
    hslList = hslList.slice(1);
  }

  const isBlackAndWhite = hslList[hslList.length - 1][2] < 0.05 || isNaN(hslList[hslList.length - 1][0]);

  if (isBlackAndWhite) {
    options.push({ step: 1, colors: ['#000000'] });
  } else {
    const hueArray = hslList.map((h) => (isNaN(h[0]) ? 0 : h[0]));
    const lumArray = hslList.map((h) => (isNaN(h[2]) ? 0 : h[2]));
    const hueDiff = hueArray.slice(1).reduce((a, h, i) => a + Math.abs(h - hueArray[i]), 0);
    const lumDiff = lumArray.slice(1).reduce((a, l, i) => a + Math.abs(l - lumArray[i]), 0);
    const isMono = hueDiff < 5 && lumDiff < 2;

    if (isMono) {
      options.push({ step: 1, colors: [hexList[hexList.length - 1]] });
    } else {
      for (let i = 1; i <= 4; i++) {
        options.push({ step: i, colors: hexList.slice(0, i) });
      }
    }
  }
  return options;
}
