import { routineProvider } from "../agenda/customer-provider";

export const reservaCustomerProvider = routineProvider({
  moduleId: "reserva", collectionId: "bookings", table: "reserva_bookings", phone: "customer_phone", checkin: true,
});
