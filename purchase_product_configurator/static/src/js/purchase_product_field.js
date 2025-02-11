/** @odoo-module */

import { PurchaseOrderLineProductField } from '@purchase_product_matrix/js/purchase_product_field';
import { serializeDateTime } from "@web/core/l10n/dates";
import { x2ManyCommands } from "@web/core/orm_service";
import { useService } from "@web/core/utils/hooks";
import { patch } from "@web/core/utils/patch";
import { PurchaseProductConfiguratorDialog } from "./product_configurator_dialog/product_configurator_dialog";
import { ormService } from "@web/core/orm_service";
import { rpc } from "@web/core/network/rpc";

async function applyProduct(record, product) {
    // handle custom values & no variants
    const customAttributesCommands = [
        x2ManyCommands.set([]),  // Command.clear isn't supported in static_list/_applyCommands
    ];
    for (const ptal of product.attribute_lines) {
        const selectedCustomPTAV = ptal.attribute_values.find(
            ptav => ptav.is_custom && ptal.selected_attribute_value_ids.includes(ptav.id)
        );
        if (selectedCustomPTAV) {
            customAttributesCommands.push(
                x2ManyCommands.create(undefined, {
                    custom_product_template_attribute_value_id: [selectedCustomPTAV.id, "we don't care"],
                    custom_value: ptal.customValue,
                })
            );
        };
    }
    const noVariantPTAVIds = product.attribute_lines.filter(
        ptal => ptal.create_variant === "no_variant" && ptal.attribute_values.length > 1
    ).flatMap(ptal => ptal.selected_attribute_value_ids);
    await record.update({
        product_id: [product.id, product.display_name],
        product_no_variant_attribute_value_ids: [x2ManyCommands.set(noVariantPTAVIds)],
        product_custom_attribute_value_ids: customAttributesCommands,
    });
    await record.update({
        product_qty: product.quantity,
    });
    };

patch(PurchaseOrderLineProductField.prototype, {
    setup() {
        super.setup(...arguments);
        this.dialog = useService("dialog");
        this.orm = useService("orm");
    },
    async _onProductTemplateUpdate() {
        const result = await this.orm.call(
            'product.template',
            'get_single_product_variant',
            [this.props.record.data.product_template_id[0]],
        );
         const product_config_mode = await this.orm.read(
            'product.template',
                [this.props.record.data.product_template_id[0]],
            ["product_config_mode"]
        );
        if(result && result.product_id) {
            if (this.props.record.data.product_id != result.product_id.id) {
                this.props.record.update({
                    // TODO right name get (same problem as configurator)
                    product_id: [result.product_id, 'whatever'],
                });
            }
        }
        else {
        if (!product_config_mode[0].product_config_mode || product_config_mode[0].product_config_mode === 'configurator') {
                this._openProductConfigurator();
            } else {
                // only triggered when purchase_product_matrix is installed.
                this._openGridConfigurator(false);
            }
        }
    },

    /**
     * Checks if the template is configurable.
     */
    get isConfigurableTemplate() {
        return super.isConfigurableTemplate || this.props.record.data.is_configurable_product;
    },
    /**
     * Opens the product configurator.
     */
    async _openProductConfigurator(jsonInfo, productTemplateId, editedCellAttributes,edit=false) {
        const purchaseOrderRecord = this.props.record.model.root;
        let ptavIds = this.props.record.data.product_template_attribute_value_ids.records.map(
            record => record.resId
        );
        let customAttributeValues = [];
        if (edit) {
            /**
             * no_variant and custom attribute don't need to be given to the configurator for new
             * products.
             */
            ptavIds = ptavIds.concat(this.props.record.data.product_no_variant_attribute_value_ids.records.map(
                record => record.resId
            ));
            /**
             *  `product_custom_attribute_value_ids` records are not loaded in the view bc sub templates
             *  are not loaded in list views. Therefore, we fetch them from the server if the record is
             *  saved. Else we use the value stored on the line.
             */
            customAttributeValues =
                this.props.record.data.product_custom_attribute_value_ids.records[0]?.isNew ?
                this.props.record.data.product_custom_attribute_value_ids.records.map(
                    record => record.data
                ) :
                await this.orm.read(
                    'product.attribute.custom.value',
                    this.props.record.data.product_custom_attribute_value_ids.currentIds,
                    ["custom_product_template_attribute_value_id", "custom_value"]
                )
        }
        this.dialog.add(PurchaseProductConfiguratorDialog, {
            productTemplateId: this.props.record.data.product_template_id[0],
            ptavIds: ptavIds,
            customAttributeValues: customAttributeValues.map(
                data => {
                    return {
                        ptavId: data.custom_product_template_attribute_value_id[0],
                        value: data.custom_value,
                    }
                }
            ),
            quantity:1.0,
            productUOMId: this.props.record.data.product_uom[0],
            companyId: purchaseOrderRecord.data.company_id[0],
            currencyId: this.props.record.data.currency_id[0],
            edit: edit,
            save: async (mainProduct, optionalProducts) => {
                await applyProduct(this.props.record, mainProduct);
                purchaseOrderRecord.data.order_line.leaveEditMode();
                for (const optionalProduct of optionalProducts) {
                    const line = await purchaseOrderRecord.data.order_line.addNewRecord({
                        position: 'bottom',
                        mode: "readonly",
                    });
                    await applyProduct(line, optionalProduct);
                }
            },
            discard: () => {
                purchaseOrderRecord.data.order_line.delete(this.props.record);
            },
        });
    },
});
