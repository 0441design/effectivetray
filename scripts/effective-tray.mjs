import { MODULE, socketID } from "./const.mjs";
import EffectiveDamageApplicationElement from "./damage-application.mjs";

export class effectiveTray {
  static init() {
    Hooks.on("dnd5e.renderChatMessage", effectiveTray._expandEffect);
    Hooks.on("preCreateItem", effectiveTray._removeTransfer);
    if (!game.settings.get(MODULE, "systemDefault")) {
      Hooks.on("dnd5e.renderChatMessage", effectiveTray._effectButton);
    };
  };

  // Expand effects tray on chat messages
  static _expandEffect(message, html) {
    if (!game.settings.get(MODULE, "expandEffect")) return;
    const tray = html.querySelector('.effects-tray');
    if (!tray) return;
    tray.classList.remove("collapsed");
    tray.classList.add("et-uncollapsed");
    tray.querySelector("i.fa-caret-down").addEventListener('click', () => {
      tray.classList.remove("et-uncollapsed");
    });
  };

  // Remove transfer from all effects with duration
  static _removeTransfer(item) {
    if (!game.settings.get(MODULE, "removeTransfer")) return;
    const effects = item.effects.contents;
    if (!effects) return;
    for (const effect of effects) {
      const transfer = effect.transfer;
      const duration = effect.duration;
      if (transfer && (duration.seconds || duration.turns || duration.rounds)) {
        effect.updateSource({"transfer": false});
      };
    };
  };

  // Make the tray effective
  static async _effectButton(message, html) {
    const tray = html.querySelector('.effects-tray');
    if (!tray) return;
    const uuid = message.flags?.dnd5e?.use?.itemUuid;
    if (!uuid) return;
    const item = await fromUuid(uuid);
    const effects = item?.effects?.contents;
    if (!effects) return;
    const actor = game.actors?.get(message.speaker?.actor);

    // Handle filtering
    if (game.settings.get(MODULE, "ignoreNPC") && actor?.type === "npc" && !actor?.isOwner) return;
    const filterDis = game.settings.get(MODULE, "filterDisposition");
    if (filterDis) {
      const token = game.scenes?.get(message.speaker?.scene)?.tokens?.get(message.speaker?.token);
      if (token && filterDis === 3 && token.disposition <= 0 && !token?.isOwner) return;
      else if (token && filterDis === 2 && token.disposition <= -1 && !token?.isOwner) return;
      else if (token && filterDis === 1 && token.disposition <= -2 && !token?.isOwner) return;
    };
    const filterPer = game.settings.get(MODULE, "filterPermission");
    if (filterPer) {
      if (filterPer === 1 && !actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED)) return;
      else if (filterPer === 2 && !actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)) return;
    };

    // Replace the effects in the tray
    const old = html.querySelectorAll('.effects-tray .effect:not(:has(> ul:empty))');
    if (old) for (const oldEffect of old) oldEffect.remove();
    const tooltip = (game.settings.get(MODULE, "allowTarget")) ? "EFFECTIVETRAY.EffectsApplyTokens" : "DND5E.EffectsApplyTokens";
    for (const effect of effects) {
      const label = effect.duration.duration ? effect.duration.label : "";
      const contents = `
        <li class="effect" data-uuid=${uuid}.ActiveEffect.${effect._id} data-transferred=${effect.transfer}>
          <img class="gold-icon" alt=${effect.name} src=${effect.icon}>
          <div class="name-stacked">
            <span class="title">${effect.name}</span>
            <span class="subtitle">${label}</span>
          </div>
          <button type="button" class="apply-${effect.name.slugify().toLowerCase()}" data-tooltip="${tooltip}" aria-label="Apply to selected tokens">
            <i class="fas fa-reply-all fa-flip-horizontal"></i>
          </button>
        </li>
      `;
      tray.querySelector('ul.effects.unlist.wrapper').insertAdjacentHTML("beforeend", contents);
      tray.querySelector(`button[class="apply-${effect.name.slugify().toLowerCase()}"]`).addEventListener('click', () => {
        if (game.settings.get(MODULE, "allowTarget") && !canvas.tokens.controlled.length) return ui.notifications.info("Select a token, or right click to apply effect to targets.")
        const actors = new Set();
        for (const token of canvas.tokens.controlled) if (token.actor) actors.add(token.actor);
        for (const actor of actors) {
          _applyEffects(actor, effect);
        };
      });
      if (!game.settings.get(MODULE, "allowTarget")) return;

      // Handle applying effects to targets: handle it if you can handle it, else emit a socket
      tray.querySelector(`button[class="apply-${effect.name.slugify().toLowerCase()}"]`).addEventListener('contextmenu', event => {
        event.stopPropagation();
        event.preventDefault();
      });
      tray.querySelector(`button[class="apply-${effect.name.slugify().toLowerCase()}"]`).addEventListener('contextmenu', () => {
        if (!game.user.targets.size) return ui.notifications.info("You don't have a target.");
        const targets = Array.from(game.user.targets).map(i=>i.document.uuid)
        if (game.user.isGM) {
          const actors = new Set();
          for (const token of game.user.targets) if (token.actor) actors.add(token.actor);
          for (const actor of actors) {
            _applyEffects(actor, effect);
          }
        } else {
          const origin = effect.uuid;
          game.socket.emit(socketID, {type: "firstCase", data: {origin, targets}});
        };
      });
    };
  };
};

export class effectiveDamage {
  static init() {
    Hooks.on("dnd5e.renderChatMessage", effectiveDamage._expandDamage);
    if (!game.settings.get(MODULE, "damageDefault")) {
      Hooks.on("dnd5e.renderChatMessage", effectiveDamage._damageTray);
    };  
  };

  // Expand the damage tray
  static async _expandDamage(message, html) {
    if (!game.settings.get(MODULE, "expandDamage")) return;
    await new Promise(r => setTimeout(r, 100));
    const tray = html.querySelector('.damage-tray');
    if (!tray) return;
    tray.classList.remove("collapsed");
    tray.classList.add("et-uncollapsed");
    tray.querySelector("i.fa-caret-down").addEventListener('click', () => {
      tray.classList.remove("et-uncollapsed");
    });
  };

  // Let users use the damage tray, either without or with the ability to target tokens other than their own
  static _damageTray(message, html) {
    if (message.flags?.dnd5e?.roll?.type === "damage") {
      const damageApplication = game.settings.get(MODULE, "damageTarget") ? 
                                document.createElement("effective-damage-application") : 
                                document.createElement("damage-application");
      damageApplication.classList.add("dnd5e2");
      if ( !game.user.isGM ) {
        damageApplication.damages = dnd5e.dice.aggregateDamageRolls(message.rolls, { respectProperties: true }).map(roll => ({
          value: roll.total,
          type: roll.options.type,
          properties: new Set(roll.options.properties ?? [])
        }));
        html.querySelector(".message-content").appendChild(damageApplication);
      };
    };
  };
};

// Make the GM client apply effects to the socket emitter's targets
async function _effectSocket(data) {
  if (game.user !== game.users.activeGM) return;
  const targets = data.data.targets;
  const effect = await fromUuid(data.data.origin);
  const actors = new Set();
  for (const target of targets) {
    const token = await fromUuid(target);
    const targetActor = token.actor;
    if (target) actors.add(targetActor);
  };
  for (const actor of actors) {
    _applyEffects(actor, effect);
  };
};

// Make the GM client apply damage to the socket emitter's targets
async function _damageSocket(data) {
  if (game.user !== game.users.activeGM) return;
  const id = data.data.id;
  const options = data.data.options;
  const dmg = data.data.dmg;
  _applyTargetDamage(id, options, dmg);
};

// Register the socket
export class effectiveSocket {
  static init() {
    game.socket.on(socketID, (data) => {
      switch (data.type) {
        case "firstCase":
          _effectSocket(data);
          break;
        case "secondCase":
          _damageSocket(data);  
      }
    });
  };
};

// Apply effect, or toggle it if it exists
function _applyEffects(actor, effect) {
  const existingEffect = actor.effects.find(e => e.origin === effect.uuid);
  if (existingEffect) {
    if (!game.settings.get(MODULE, "deleteInstead")) {
      return existingEffect.update({
        ...effect.constructor.getInitialDuration(),
        disabled: false
      });
    } else existingEffect.delete();
  } else {
    const effectData = foundry.utils.mergeObject(effect.toObject(), {
      disabled: false,
      transfer: false,
      origin: effect.uuid
    });
    ActiveEffect.implementation.create(effectData, {parent: actor});
  };
};

// Apply damage
async function _applyTargetDamage(id, options, dmg) {
  const actor = fromUuidSync(id);
  await actor.applyDamage(dmg, options);
};