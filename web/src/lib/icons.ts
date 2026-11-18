import arrowLeft from "@tabler/icons/outline/arrow-left.svg?raw";
import bell from "@tabler/icons/outline/bell.svg?raw";
import check from "@tabler/icons/outline/check.svg?raw";
import download from "@tabler/icons/outline/download.svg?raw";
import fax from "@tabler/icons/outline/printer.svg?raw";
import loader from "@tabler/icons/outline/loader-2.svg?raw";
import message from "@tabler/icons/outline/message-circle.svg?raw";
import messagePlus from "@tabler/icons/outline/message-plus.svg?raw";
import phone from "@tabler/icons/outline/phone.svg?raw";
import phoneIncoming from "@tabler/icons/outline/phone-incoming.svg?raw";
import phoneOutgoing from "@tabler/icons/outline/phone-outgoing.svg?raw";
import phoneX from "@tabler/icons/outline/phone-x.svg?raw";
import refresh from "@tabler/icons/outline/refresh.svg?raw";
import send from "@tabler/icons/outline/send.svg?raw";
import voicemail from "@tabler/icons/outline/headphones.svg?raw";
import backspace from "@tabler/icons/outline/backspace.svg?raw";
import checks from "@tabler/icons/outline/checks.svg?raw";
import dialpad from "@tabler/icons/outline/dialpad.svg?raw";
import mic from "@tabler/icons/outline/microphone.svg?raw";
import micOff from "@tabler/icons/outline/microphone-off.svg?raw";
import pause from "@tabler/icons/outline/player-pause.svg?raw";
import play from "@tabler/icons/outline/player-play.svg?raw";
import phoneOff from "@tabler/icons/outline/phone-off.svg?raw";
import volume from "@tabler/icons/outline/volume.svg?raw";
import mailOpened from "@tabler/icons/outline/mail-opened.svg?raw";
import wifiOff from "@tabler/icons/outline/wifi-off.svg?raw";
import circleCheck from "@tabler/icons/outline/circle-check.svg?raw";
import alertCircle from "@tabler/icons/outline/alert-circle.svg?raw";

const raw = { backspace, checks, dialpad, mic, micOff, pause, play, phoneOff, volume, mailOpened, arrowLeft, bell, check, circleCheck, alertCircle, download, fax, loader, message, messagePlus, phone, phoneIncoming, phoneOutgoing, phoneX, refresh, send, voicemail, wifiOff };
export type IconName = keyof typeof raw;

// The SVG text is bundled from @tabler/icons at build time, never from user data.
export function icon(name: IconName, className = "size-4"): SVGElement {
  const template = document.createElement("template");
  template.innerHTML = raw[name];
  const svg = template.content.firstElementChild as SVGElement;
  svg.setAttribute("class", `${className} shrink-0`);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}
